const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;

function ensureAbsoluteUrl(url) {
  if (url.startsWith('//')) {
    return `https:${url}`;
  }
  if (url.startsWith('http')) {
    return url;
  }
  return `https://cuescore.com${url}`;
}

// 🔠 Skrócenie nazwy rundy
function abbreviateRound(round) {
  const roundLower = round.toLowerCase().trim();
  if (roundLower === "last sixteen") return "L16";
  if (roundLower === "semi final") return "SF";
  if (roundLower === "final") return "F";

  const words = round.split(" ");
  return words.map(w => {
    const match = w.match(/^([a-zA-Z])([0-9]*)/);
    if (match) return match[1].toUpperCase() + match[2];
    return '';
  }).join('');
}

// 🧍 Wyciąganie tylko nazwiska
function getLastName(fullName) {
  const parts = fullName.trim().split(' ');
  return parts[parts.length - 1];
}

app.get('/score', async (req, res) => {
  const { playerId } = req.query;

  if (!playerId) {
    return res.status(400).json({ error: 'Missing playerId parameter' });
  }

  try {
    const participantApiUrl = `https://api.cuescore.com/participant/?id=${playerId}`;
    const participantResponse = await axios.get(participantApiUrl);
    const playerPageUrl = ensureAbsoluteUrl(participantResponse.data.url);

    if (!playerPageUrl) {
      return res.status(404).json({ error: 'Player URL not found in Cuescore participant API.' });
    }

    const playerPageHtml = (await axios.get(playerPageUrl)).data;
    const $ = cheerio.load(playerPageHtml);
    const liveMatchLink = $('.liveMatches .match .name a').attr('href');

    if (!liveMatchLink) {
      return res.status(404).json({ error: 'No live match found on player\'s Cuescore page.' });
    }

    const tournamentIdMatch = liveMatchLink.match(/tournament\/[^\/]+\/(\d+)/);
    if (!tournamentIdMatch || !tournamentIdMatch[1]) {
      return res.status(500).json({ error: 'Could not extract tournamentId from live match link.' });
    }
    const tournamentId = tournamentIdMatch[1];

    const tournamentApiUrl = `https://api.cuescore.com/tournament/?id=${tournamentId}`;
    const tournamentResponse = await axios.get(tournamentApiUrl);
    const allTournamentMatches = tournamentResponse.data.matches;

    const playerMatches = allTournamentMatches.filter(match =>
      match.playerA.playerId == playerId || match.playerB.playerId == playerId
    );

    if (playerMatches.length === 0) {
      return res.status(404).json({ error: 'No matches found for the player in the live tournament.' });
    }

    const formattedMatches = playerMatches.map(match => {
      const isPlayerA = match.playerA.playerId == playerId;
      const playerA = match.playerA;
      const playerB = match.playerB;

      const name1 = getLastName(isPlayerA ? playerA.name : playerB.name);
      const name2 = getLastName(isPlayerA ? playerB.name : playerA.name);

      return {
        matchId: match.matchId,
        round: match.roundName,
        player1: `<strong>${name1}</strong>`,
        player2: `<strong>${name2}</strong>`,
        score1: isPlayerA ? match.scoreA : match.scoreB,
        score2: isPlayerA ? match.scoreB : match.scoreA,
        raceTo: match.raceTo,
        table: Array.isArray(match.table) ? match.table.join(', ') : match.table,
        flag1: isPlayerA ? playerA.country?.image : playerB.country?.image,
        flag2: isPlayerA ? playerB.country?.image : playerA.country?.image,
        status: match.matchstatus,
        discipline: match.discipline
      };
    });

    const currentMatch = formattedMatches.pop();

    const history = formattedMatches.map(match => {
      const abbrevRound = abbreviateRound(match.round);
      const p1 = match.player1.replace(/<\/?strong>/g, ''); // usuń <strong> z nazwisk
      const p2 = match.player2.replace(/<\/?strong>/g, '');
      const s1 = parseInt(match.score1, 10);
      const s2 = parseInt(match.score2, 10);

      const boldP1 = s1 > s2 ? `<strong>${p1}</strong>` : p1;
      const boldP2 = s2 > s1 ? `<strong>${p2}</strong>` : p2;

      return `<strong>${abbrevRound}</strong>: ${boldP1} ${s1} - ${s2} ${boldP2}`;
    });

    return res.json({
      allMatches: [currentMatch],
      matchHistory: history.reverse()
    });

  } catch (e) {
    console.error(e);
    const errorMessage = e.response ? JSON.stringify(e.response.data) : e.message;
    return res.status(500).json({ error: 'Failed to fetch or parse Cuescore data.', details: errorMessage });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
