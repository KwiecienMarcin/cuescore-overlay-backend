const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;

// 🧠 Pamięć na wynik początkowy meczu (w RAM)
const startScores = new Map();

// 🔧 Upewniamy się, że URL jest kompletny
function ensureAbsoluteUrl(url) {
  if (url.startsWith('//')) {
    return `https:${url}`;
  }
  if (url.startsWith('http')) {
    return url;
  }
  return `https://cuescore.com${url}`;
}

app.get('/score', async (req, res) => {
  const { playerId } = req.query;

  if (!playerId) {
    return res.status(400).json({ error: 'Missing playerId parameter' });
  }

  try {
    // 🔗 Pobierz dane gracza z Cuescore API
    const participantApiUrl = `https://api.cuescore.com/participant/?id=${playerId}`;
    const participantResponse = await axios.get(participantApiUrl);
    const playerPageUrl = ensureAbsoluteUrl(participantResponse.data.url);

    if (!playerPageUrl) {
      return res.status(404).json({ error: 'Player URL not found in Cuescore participant API.' });
    }

    // 🔍 Scrapowanie strony gracza
    const playerPageHtml = (await axios.get(playerPageUrl)).data;
    const $ = cheerio.load(playerPageHtml);
    const liveMatchLink = $('.liveMatches .match .name a').attr('href');

    if (!liveMatchLink) {
      return res.status(404).json({ error: 'No live match found on player\'s Cuescore page.' });
    }

    // 🎯 Wyciągnięcie ID turnieju z linku
    const tournamentIdMatch = liveMatchLink.match(/tournament\/[^\/]+\/(\d+)/);
    if (!tournamentIdMatch || !tournamentIdMatch[1]) {
      return res.status(500).json({ error: 'Could not extract tournamentId from live match link.' });
    }

    const tournamentId = tournamentIdMatch[1];

    // 🧠 SCRAPOWANIE STRONY TURNIEJU
    const tournamentUrl = `https://cuescore.com/tournament/${tournamentId}`;
    const tournamentPageHtml = (await axios.get(tournamentUrl)).data;
    const $$ = cheerio.load(tournamentPageHtml);

    const tournamentName = $$('h1.tournament-header').text().trim();
    const infoSpans = $$('.info span');
    const date = infoSpans.eq(0).text().trim();
    const club = infoSpans.eq(1).text().trim();

    const formatLine = $$('.info').text();
    const formatMatch = formatLine.match(/([A-Za-ząćęłńóśźżĄĆĘŁŃÓŚŹŻ\s\-]+)\s+\((\d+)\s+Uczestnicy\)/);
    const format = formatMatch ? formatMatch[1].trim() : '';
    const playersCount = formatMatch ? parseInt(formatMatch[2]) : 0;

    const handicapMatch = formatLine.match(/(Bez handicapu|Handicap[\w\s]*)/);
    const handicap = handicapMatch ? handicapMatch[1].trim() : '';

    const tournamentInfo = {
      tournamentId,
      tournamentName,
      date,
      club,
      format,
      playersCount,
      handicap
    };

    // 📡 Pobierz mecze turnieju z API
    const tournamentApiUrl = `https://api.cuescore.com/tournament/?id=${tournamentId}`;
    const tournamentResponse = await axios.get(tournamentApiUrl);
    const allTournamentMatches = tournamentResponse.data.matches;

    // 🎯 Filtruj mecze z udziałem naszego gracza
    const playerMatches = allTournamentMatches.filter(match =>
      match.playerA.playerId == playerId || match.playerB.playerId == playerId
    );

    if (playerMatches.length === 0) {
      return res.status(404).json({ error: 'No matches found for the player in the live tournament.' });
    }

    // 🧾 Formatowanie meczów
    const formattedMatches = playerMatches.map(match => {
      const isPlayerA = match.playerA.playerId == playerId;
      const playerA = match.playerA;
      const playerB = match.playerB;

      return {
        matchId: match.matchId,
        round: match.roundName,
        player1: isPlayerA ? playerA.name : playerB.name,
        player2: isPlayerA ? playerB.name : playerA.name,
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

    const currentMatch = formattedMatches.pop(); // ostatni mecz = aktualny
    const history = formattedMatches.map(match => {
      return `${match.round}: ${match.player1} ${match.score1} - ${match.score2} ${match.player2}`;
    });

    // ⏱ Zapisz wynik startowy
    const matchId = currentMatch.matchId;
    if (!startScores.has(matchId)) {
      startScores.set(matchId, {
        score1: currentMatch.score1,
        score2: currentMatch.score2
      });
    }

    const startScore = startScores.get(matchId);

    // 📤 Odpowiedź
    return res.json({
      allMatches: [currentMatch],
      matchHistory: history.reverse(),
      startScore,
      tournamentInfo
    });

  } catch (e) {
    console.error(e);
    const errorMessage = e.response ? JSON.stringify(e.response.data) : e.message;
    return res.status(500).json({ error: 'Failed to fetch or parse Cuescore data.', details: errorMessage });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
