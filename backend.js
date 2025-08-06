const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;

// Pomocnicza funkcja: upewnia się, że URL jest kompletny
function ensureAbsoluteUrl(url) {
  if (url.startsWith('//')) {
    return `https:${url}`;
  }
  if (url.startsWith('http')) {
    return url;
  }
  return `https://cuescore.com${url}`;
}

// Funkcja do skracania nazw rund
function shortenRoundName(roundName) {
  if (!roundName) return '';

  const name = roundName.trim().toLowerCase();

  if (name === 'last sixteen') return 'L16';
  if (name === 'semi final') return 'SF';
  if (name === 'final') return 'F';
  if (name === 'quarter final') return 'QF'; // poprawka Q -> QF

  // Wyciągnij pierwszą literę pierwszego słowa, duża litera
  const firstLetter = roundName.trim()[0].toUpperCase();

  // Znajdź pierwszą liczbę (np. "Round 4" → 4)
  const numberMatch = roundName.match(/\d+/);
  const number = numberMatch ? numberMatch[0] : '';

  return firstLetter + number;
}

// Funkcja skracająca pełne nazwy do samych nazwisk w historii
function shortenNamesInHistory(history) {
  return history.map(entry => {
    // Regex znajdzie wynik (np. "4 - 3")
    const scoreRegex = /\d+\s*-\s*\d+/;
    const scoreMatch = entry.match(scoreRegex);

    if (!scoreMatch) return entry;

    const score = scoreMatch[0];
    const parts = entry.split(score);

    if (parts.length !== 2) return entry;

    // Usuwamy prefix rundy z lewej strony, np. "QF: Witold Żarowski" -> "Witold Żarowski"
    const leftPart = parts[0].trim();
    const rightPart = parts[1].trim();

    const leftNameFull = leftPart.replace(/^[A-Z0-9]+:\s*/, '');
    const leftLastName = leftNameFull.split(' ').slice(-1)[0];

    const rightLastName = rightPart.split(' ').slice(-1)[0];

    const roundPrefixMatch = parts[0].match(/^[A-Z0-9]+:/);
    const roundPrefix = roundPrefixMatch ? roundPrefixMatch[0] : '';

    return `${roundPrefix} ${leftLastName} ${score} ${rightLastName}`.trim();
  });
}

app.get('/score', async (req, res) => {
  const { playerId } = req.query;

  if (!playerId) {
    return res.status(400).json({ error: 'Missing playerId parameter' });
  }

  try {
    // Krok 1: Pobierz URL strony gracza
    const participantApiUrl = `https://api.cuescore.com/participant/?id=${playerId}`;
    const participantResponse = await axios.get(participantApiUrl);
    const playerPageUrl = ensureAbsoluteUrl(participantResponse.data.url);

    if (!playerPageUrl) {
      return res.status(404).json({ error: 'Player URL not found in Cuescore participant API.' });
    }

    // Krok 2: Scrapuj stronę gracza
    const playerPageHtml = (await axios.get(playerPageUrl)).data;
    const $ = cheerio.load(playerPageHtml);

    const liveMatchLink = $('.liveMatches .match .name a').attr('href');

    if (!liveMatchLink) {
      return res.status(404).json({ error: 'No live match found on player\'s Cuescore page.' });
    }

    // Krok 3: Wyciągnij tournamentId
    const tournamentIdMatch = liveMatchLink.match(/tournament\/[^\/]+\/(\d+)/);
    if (!tournamentIdMatch || !tournamentIdMatch[1]) {
      return res.status(500).json({ error: 'Could not extract tournamentId from live match link.' });
    }
    const tournamentId = tournamentIdMatch[1];

    // Krok 4: Pobierz dane turnieju
    const tournamentApiUrl = `https://api.cuescore.com/tournament/?id=${tournamentId}`;
    const tournamentResponse = await axios.get(tournamentApiUrl);
    const allTournamentMatches = tournamentResponse.data.matches;

    // Krok 5: Filtruj mecze gracza
    const playerMatches = allTournamentMatches.filter(match =>
      match.playerA.playerId == playerId || match.playerB.playerId == playerId
    );

    if (playerMatches.length === 0) {
      return res.status(404).json({ error: 'No matches found for the player in the live tournament.' });
    }

    // Krok 6: Formatuj dane
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

    // Oddziel aktualny mecz i historię
    const currentMatch = formattedMatches.pop();

    const historyRaw = formattedMatches.map(match => {
      const shortRound = shortenRoundName(match.round);
      return `${shortRound}: ${match.player1} ${match.score1} - ${match.score2} ${match.player2}`;
    });

    const history = shortenNamesInHistory(historyRaw);

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
