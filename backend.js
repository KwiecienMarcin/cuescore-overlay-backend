const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio'); // Cheerio jest nadal potrzebne do scrapowania strony gracza
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

app.get('/score', async (req, res) => {
  const { playerId } = req.query;

  if (!playerId) {
    return res.status(400).json({ error: 'Missing playerId parameter' });
  }

  try {
    // KROK 1: Pobierz URL strony gracza z API Cuescore, aby mieć pewność, że mamy poprawny link
    const participantApiUrl = `https://api.cuescore.com/participant/?id=${playerId}`;
    const participantResponse = await axios.get(participantApiUrl);
    const playerPageUrl = ensureAbsoluteUrl(participantResponse.data.url);

    if (!playerPageUrl) {
      return res.status(404).json({ error: 'Player URL not found in Cuescore participant API.' });
    }

    // KROK 2: Scrapuj stronę gracza w poszukiwaniu linku do turnieju na żywo
    const playerPageHtml = (await axios.get(playerPageUrl)).data;
    const $ = cheerio.load(playerPageHtml);

    const liveMatchLink = $('.liveMatches .match .name a').attr('href');

    if (!liveMatchLink) {
      return res.status(404).json({ error: 'No live match found on player\'s Cuescore page.' });
    }

    // KROK 3: Wyciągnij ID turnieju z linku
    const tournamentIdMatch = liveMatchLink.match(/tournament\/[^\/]+\/(\d+)/);
    if (!tournamentIdMatch || !tournamentIdMatch[1]) {
      return res.status(500).json({ error: 'Could not extract tournamentId from live match link.' });
    }
    const tournamentId = tournamentIdMatch[1];

    // KROK 4: Użyj ID turnieju, aby pobrać wszystkie dane o meczach z API
    const tournamentApiUrl = `https://api.cuescore.com/tournament/?id=${tournamentId}`;
    const tournamentResponse = await axios.get(tournamentApiUrl);
    const allTournamentMatches = tournamentResponse.data.matches;

    // KROK 5: Filtruj mecze, aby znaleźć tylko te z udziałem naszego gracza
    const playerMatches = allTournamentMatches.filter(match =>
        match.playerA.playerId == playerId || match.playerB.playerId == playerId
    );

    if (playerMatches.length === 0) {
      return res.status(404).json({ error: 'No matches found for the player in the live tournament.' });
    }

    // KROK 6: Mapuj dane do formatu oczekiwanego przez frontend
    const formattedMatches = playerMatches.map(match => {
      // Upewnij się, że "nasz" gracz jest zawsze jako player1
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
        status: match.matchstatus, // "playing", "finished", etc.
        discipline: match.discipline
      };
    });

    // Ostatni mecz to mecz bieżący
    const currentMatch = formattedMatches.pop(); // Usuwa i zwraca ostatni element

    // Reszta to historia
    const history = formattedMatches.map(match => {
      // Proste formatowanie historii
      return `${match.round}: ${match.player1} ${match.score1} - ${match.score2} ${match.player2}`;
    });

    return res.json({
      allMatches: [currentMatch], // Zwracamy jako tablicę z jednym elementem, aby pasowało do logiki frontendu
      matchHistory: history.reverse() // Odwracamy, aby najnowsze mecze historii były na górze
    });

  } catch (e) {
    console.error(e);
    const errorMessage = e.response ? JSON.stringify(e.response.data) : e.message;
    return res.status(500).json({ error: 'Failed to fetch or parse Cuescore data.', details: errorMessage });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));