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
      return res.status(404).json({ error: 'Player URL not found.' });
    }

    // Krok 2: Scrapuj stronę gracza, żeby znaleźć mecz na żywo
    const playerPageHtml = (await axios.get(playerPageUrl)).data;
    const $ = cheerio.load(playerPageHtml);

    const liveMatchLink = $('.liveMatches .match .name a').attr('href');
    if (!liveMatchLink) {
      return res.status(404).json({ error: 'No live match found.' });
    }

    // Krok 3: Pobierz ID turnieju
    const tournamentIdMatch = liveMatchLink.match(/tournament\/[^\/]+\/(\d+)/);
    if (!tournamentIdMatch || !tournamentIdMatch[1]) {
      return res.status(500).json({ error: 'Could not extract tournamentId.' });
    }
    const tournamentId = tournamentIdMatch[1];

    // Krok 4: Pobierz dane turnieju z API
    const tournamentApiUrl = `https://api.cuescore.com/tournament/?id=${tournamentId}`;
    const tournamentResponse = await axios.get(tournamentApiUrl);
    const allTournamentMatches = tournamentResponse.data.matches;

    // Krok 5: Znajdź mecze gracza
    const playerMatches = allTournamentMatches.filter(match =>
      match.playerA.playerId == playerId || match.playerB.playerId == playerId
    );

    if (playerMatches.length === 0) {
      return res.status(404).json({ error: 'No matches found for this player.' });
    }

    // Krok 6: Formatowanie meczów
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

    const currentMatch = formattedMatches.pop();
    const startScore = {
      score1: currentMatch.score1,
      score2: currentMatch.score2
    };

    const history = formattedMatches.map(match =>
      `${match.round}: ${match.player1} ${match.score1} - ${match.score2} ${match.player2}`
    );

    // Krok 7: Scrapowanie dodatkowych informacji o turnieju
    const fullTournamentUrl = ensureAbsoluteUrl(liveMatchLink.split('/match/')[0]);
    const tournamentPageHtml = (await axios.get(fullTournamentUrl)).data;
    const $$ = cheerio.load(tournamentPageHtml);

    const tournamentName = $$('.main h1').text().trim();
    const club = $$('.location a').first().text().trim();
    const date = $$('.meta').first().text().trim();
    const formatAndPlayersRaw = $$('.meta').eq(1).text().trim();
    const handicapRaw = $$('.meta').filter((i, el) => $$(el).text().includes('handicap')).text().trim();

    // Parsowanie formatu i liczby graczy
    const formatMatch = formatAndPlayersRaw.match(/^(.+?)\s+\((\d+)\s+Uczestnicy/);
    const format = formatMatch ? formatMatch[1] : '';
    const playersCount = formatMatch ? formatMatch[2] : '';

    const handicap = handicapRaw || '';

    // Zwracamy pełną odpowiedź
    return res.json({
      tournamentInfo: {
        name: tournamentName,
        date,
        club,
        format,
        playersCount,
        handicap
      },
      allMatches: [currentMatch],
      matchHistory: history.reverse(),
      startScore
    });

  } catch (e) {
    console.error(e);
    const errorMessage = e.response ? JSON.stringify(e.response.data) : e.message;
    return res.status(500).json({ error: 'Failed to fetch or parse Cuescore data.', details: errorMessage });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
