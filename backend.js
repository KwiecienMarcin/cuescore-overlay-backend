const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;

// Funkcja pomocnicza do upewnienia się, że URL jest pełny
function ensureAbsoluteUrl(url) {
  if (url.startsWith('//')) {
    return `https:${url}`;
  }
  if (url.startsWith('http')) {
    return url;
  }
  return `https://cuescore.com${url}`;
}

// Funkcja pomocnicza do skracania nazwy rundy
function shortenRound(roundName) {
  return roundName.replace(/Round\s+(\d+)/i, 'R$1');
}

// Funkcja pomocnicza do pobrania tylko nazwiska (ostatniego członu imienia)
function getLastName(fullName) {
  if (!fullName) return '';
  const parts = fullName.trim().split(/\s+/);
  return parts[parts.length - 1];
}

app.get('/score', async (req, res) => {
  const { playerId } = req.query;

  if (!playerId) {
    return res.status(400).json({ error: 'Missing playerId parameter' });
  }

  try {
    // KROK 1
    const participantApiUrl = `https://api.cuescore.com/participant/?id=${playerId}`;
    const participantResponse = await axios.get(participantApiUrl);
    const playerPageUrl = ensureAbsoluteUrl(participantResponse.data.url);

    if (!playerPageUrl) {
      return res.status(404).json({ error: 'Player URL not found in Cuescore participant API.' });
    }

    // KROK 2
    const playerPageHtml = (await axios.get(playerPageUrl)).data;
    const $ = cheerio.load(playerPageHtml);

    const liveMatchLink = $('.liveMatches .match .name a').attr('href');

    if (!liveMatchLink) {
      return res.status(404).json({ error: 'No live match found on player\'s Cuescore page.' });
    }

    // KROK 3
    const tournamentIdMatch = liveMatchLink.match(/tournament\/[^\/]+\/(\d+)/);
    if (!tournamentIdMatch || !tournamentIdMatch[1]) {
      return res.status(500).json({ error: 'Could not extract tournamentId from live match link.' });
    }
    const tournamentId = tournamentIdMatch[1];

    // KROK 4
    const tournamentApiUrl = `https://api.cuescore.com/tournament/?id=${tournamentId}`;
    const tournamentResponse = await axios.get(tournamentApiUrl);
    const allTournamentMatches = tournamentResponse.data.matches;

    // KROK 5
    const playerMatches = allTournamentMatches.filter(match =>
      match.playerA.playerId == playerId || match.playerB.playerId == playerId
    );

    if (playerMatches.length === 0) {
      return res.status(404).json({ error: 'No matches found for the player in the live tournament.' });
    }

    // KROK 6
    const formattedMatches = playerMatches.map(match => {
      const isPlayerA = match.playerA.playerId == playerId;

      const playerA = match.playerA;
      const playerB = match.playerB;

      const name1 = getLastName(isPlayerA ? playerA.name : playerB.name);
      const name2 = getLastName(isPlayerA ? playerB.name : playerA.name);

      return {
        matchId: match.matchId,
        round: shortenRound(match.roundName),
        player1: name1,
        player2: name2,
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
      return `${match.round}: ${match.player1} ${match.score1} - ${match.score2} ${match.player2}`;
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
