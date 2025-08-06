const express = require('express');
const axios = require('axios');
const puppeteer = require('puppeteer');
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
    // KROK 1: Pobierz URL profilu gracza
    const participantApiUrl = `https://api.cuescore.com/participant/?id=${playerId}`;
    const participantResponse = await axios.get(participantApiUrl);
    const playerPageUrl = ensureAbsoluteUrl(participantResponse.data.url);

    if (!playerPageUrl) {
      return res.status(404).json({ error: 'Player URL not found in Cuescore participant API.' });
    }

    // KROK 2: Scrapuj stronę gracza w poszukiwaniu linku do turnieju live
    const playerPageHtml = (await axios.get(playerPageUrl)).data;
    const liveMatchLinkMatch = playerPageHtml.match(/href="\/tournament\/[^\/]+\/\d+\/match\/\d+"/);
    if (!liveMatchLinkMatch) {
      return res.status(404).json({ error: 'No live match found on player\'s Cuescore page.' });
    }

    const liveMatchLink = liveMatchLinkMatch[0].match(/\/tournament\/[^\/]+\/\d+/)[0];
    const tournamentIdMatch = liveMatchLink.match(/\/tournament\/[^\/]+\/(\d+)/);
    const tournamentId = tournamentIdMatch ? tournamentIdMatch[1] : null;

    if (!tournamentId) {
      return res.status(500).json({ error: 'Could not extract tournamentId.' });
    }

    // KROK 3: Pobierz dane o turnieju z API
    const tournamentApiUrl = `https://api.cuescore.com/tournament/?id=${tournamentId}`;
    const tournamentResponse = await axios.get(tournamentApiUrl);
    const allTournamentMatches = tournamentResponse.data.matches;

    const playerMatches = allTournamentMatches.filter(match =>
      match.playerA.playerId == playerId || match.playerB.playerId == playerId
    );

    if (playerMatches.length === 0) {
      return res.status(404).json({ error: 'No matches found for this player.' });
    }

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

    const matchHistory = formattedMatches.map(match =>
      `${match.round}: ${match.player1} ${match.score1} - ${match.score2} ${match.player2}`
    );

    // KROK 4: Scrapowanie danych ogólnych o turnieju przez Puppeteer
    const fullTournamentUrl = `https://cuescore.com${liveMatchLink}`;
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(fullTournamentUrl, { waitUntil: 'networkidle0' });

    const tournamentInfo = await page.evaluate(() => {
      const name = document.querySelector('.main h1')?.textContent?.trim() || '';
      const date = document.querySelector('.meta')?.textContent?.trim() || '';
      const club = document.querySelector('.location a')?.textContent?.trim() || '';

      const metaElements = Array.from(document.querySelectorAll('.meta'));
      const formatLine = metaElements.find(el => el.textContent?.includes('Uczestnicy'))?.textContent?.trim() || '';
      const handicapLine = metaElements.find(el => el.textContent?.toLowerCase().includes('handicap'))?.textContent?.trim() || '';

      const formatMatch = formatLine.match(/^(.+?)\s+\((\d+)\s+Uczestnicy/);
      const format = formatMatch ? formatMatch[1] : '';
      const playersCount = formatMatch ? formatMatch[2] : '';

      return {
        name,
        date,
        club,
        format,
        playersCount,
        handicap: handicapLine
      };
    });

    await browser.close();

    return res.json({
      tournamentInfo,
      allMatches: [currentMatch],
      matchHistory: matchHistory.reverse(),
      startScore
    });

  } catch (e) {
    console.error(e);
    const errorMessage = e.response ? JSON.stringify(e.response.data) : e.message;
    return res.status(500).json({ error: 'Failed to fetch or parse Cuescore data.', details: errorMessage });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
