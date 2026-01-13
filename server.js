import express from 'express';
import fetch from 'node-fetch';
import axios from 'axios';
import cors from 'cors';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';
import { existsSync, readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Загружаем конфигурацию из JSON файла или .env
function loadConfig() {
  const configJsonPath = join(__dirname, 'config.json');
  const envPath = join(__dirname, '.env');
  
  // Приоритет: сначала JSON, потом .env
  if (existsSync(configJsonPath)) {
    try {
      const configData = JSON.parse(readFileSync(configJsonPath, 'utf-8'));
      console.log('✅ Конфигурация загружена из config.json');
      
      // Устанавливаем переменные окружения из JSON
      Object.keys(configData).forEach((key) => {
        if (configData[key] !== undefined && configData[key] !== null && configData[key] !== '') {
          process.env[key] = String(configData[key]);
        }
      });
      
      console.log('📋 Загруженные настройки из config.json:');
      if (process.env.SOUNDCLOUD_CLIENT_ID) {
        console.log(`   SOUNDCLOUD_CLIENT_ID: установлено ✅ (пользовательский ключ)`);
      } else {
        console.log(`   SOUNDCLOUD_CLIENT_ID: не установлено (используется дефолтный ключ)`);
        console.log(`   ⚠️  Если получаете ошибки 401, получите новый CLIENT_ID:`);
        console.log(`      https://developers.soundcloud.com/ → Register your app → Client ID`);
        console.log(`      Добавьте в config.json: "SOUNDCLOUD_CLIENT_ID": "ваш_ключ"`);
      }
      if (process.env.MUSIXMATCH_API_KEY) {
        console.log(`   MUSIXMATCH_API_KEY: установлено ✅ (пользовательский ключ - для текстов песен)`);
      } else {
        console.log(`   MUSIXMATCH_API_KEY: не установлено (будет использован community ключ для текстов - бесплатно, не требует регистрации)`);
      }
      console.log(`   SUNO_API_KEY: ${process.env.SUNO_API_KEY ? 'установлено ✅' : 'не установлено (опционально)'}`);
      console.log('');
      
      return true;
    } catch (error) {
      console.error('❌ Ошибка при загрузке config.json:', error);
      console.log('⚠️ Пытаемся загрузить из .env...');
    }
  }
  
  // Загружаем из .env, если JSON не найден или произошла ошибка
  if (existsSync(envPath)) {
    const result = dotenv.config({ path: envPath });
    if (result.error) {
      console.error('❌ Ошибка загрузки .env файла:', result.error);
    } else {
      console.log('✅ .env файл загружен успешно');
    }
    return true;
  } else {
    console.warn('⚠️ config.json и .env файлы не найдены');
    return false;
  }
}

loadConfig();

const app = express();
app.use(cors());
app.use(express.json());

// SoundCloud CLIENT_ID - можно переопределить через config.json или .env
// Если не указан, будет использован дефолтный (может не работать)
const CLIENT_ID = process.env.SOUNDCLOUD_CLIENT_ID || "ryRUzIe9hOPkIaQ8QRP97XcuYzdhStHs";

// Инициализация SQLite базы данных
const dbPath = join(__dirname, 'music_player.db');
const db = new Database(dbPath);

// Создание таблиц при первом запуске
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    code TEXT PRIMARY KEY,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS listening_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_code TEXT NOT NULL,
    track_id INTEGER NOT NULL,
    track_title TEXT,
    artist_name TEXT,
    artwork_url TEXT,
    played_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_code) REFERENCES users(code)
  );

  CREATE INDEX IF NOT EXISTS idx_user_code ON listening_history(user_code);
  CREATE INDEX IF NOT EXISTS idx_track_id ON listening_history(track_id);

  CREATE TABLE IF NOT EXISTS playlists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_code TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_code) REFERENCES users(code)
  );

  CREATE TABLE IF NOT EXISTS playlist_tracks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    playlist_id INTEGER NOT NULL,
    track_id INTEGER NOT NULL,
    track_title TEXT,
    artist_name TEXT,
    artwork_url TEXT,
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    position INTEGER DEFAULT 0,
    FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS liked_tracks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_code TEXT NOT NULL,
    track_id INTEGER NOT NULL,
    track_title TEXT,
    artist_name TEXT,
    artwork_url TEXT,
    liked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_code) REFERENCES users(code),
    UNIQUE(user_code, track_id)
  );

  CREATE TABLE IF NOT EXISTS search_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_code TEXT NOT NULL,
    track_id INTEGER NOT NULL,
    track_title TEXT,
    artist_name TEXT,
    artwork_url TEXT,
    searched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_code) REFERENCES users(code)
  );

  CREATE INDEX IF NOT EXISTS idx_playlists_user_code ON playlists(user_code);
  CREATE INDEX IF NOT EXISTS idx_playlist_tracks_playlist_id ON playlist_tracks(playlist_id);
  CREATE INDEX IF NOT EXISTS idx_liked_tracks_user_code ON liked_tracks(user_code);
  CREATE INDEX IF NOT EXISTS idx_liked_tracks_track_id ON liked_tracks(track_id);
  CREATE INDEX IF NOT EXISTS idx_search_history_user_code ON search_history(user_code);
  CREATE INDEX IF NOT EXISTS idx_search_history_track_id ON search_history(track_id);
`);

console.log('✅ База данных SQLite инициализирована:', dbPath);

// Тестовый эндпоинт для проверки работы сервера
app.get('/api/test', (req, res) => {
  res.json({ 
    message: 'Сервер работает!',
    timestamp: new Date().toISOString(),
    routes: ['/api/users', '/api/history', '/api/search', '/api/new-releases', '/api/stream']
  });
});

// API для работы с пользователями
app.post('/api/users', (req, res) => {
  try {
    const { code } = req.body;
    
    console.log('📥 Запрос на создание/получение пользователя:', code);
    
    if (!code) {
      return res.status(400).json({ error: 'Код пользователя не указан' });
    }
    
    if (typeof code !== 'string') {
      return res.status(400).json({ error: 'Код должен быть строкой' });
    }
    
    if (code.length < 3) {
      return res.status(400).json({ error: 'Код должен быть не менее 3 символов' });
    }

    // Проверяем, существует ли пользователь
    const stmt = db.prepare('SELECT code FROM users WHERE code = ?');
    const existing = stmt.get(code);
    
    if (!existing) {
      // Создаем нового пользователя
      try {
        const insertStmt = db.prepare('INSERT INTO users (code) VALUES (?)');
        insertStmt.run(code);
        console.log(`✅ Создан новый пользователь: ${code}`);
      } catch (insertError) {
        // Проверяем, не дубликат ли это (если между проверкой и вставкой создался другой поток)
        if (insertError.code === 'SQLITE_CONSTRAINT' || insertError.message?.includes('UNIQUE')) {
          console.log(`ℹ️ Пользователь ${code} уже существует (конкурентное создание)`);
        } else {
          throw insertError;
        }
      }
    } else {
      console.log(`ℹ️ Пользователь ${code} уже существует`);
    }

    res.json({ code, success: true });
  } catch (error) {
    console.error('❌ Ошибка при создании/получении пользователя:', error);
    console.error('Детали ошибки:', {
      message: error.message,
      code: error.code,
      stack: error.stack
    });
    res.status(500).json({ 
      error: 'Ошибка сервера',
      details: error.message || 'Неизвестная ошибка'
    });
  }
});

// API для сохранения в историю прослушивания
app.post('/api/history', (req, res) => {
  try {
    const { userCode, track } = req.body;
    
    if (!userCode || !track || !track.id) {
      return res.status(400).json({ error: 'Неверные данные' });
    }

    const stmt = db.prepare(`
      INSERT INTO listening_history (user_code, track_id, track_title, artist_name, artwork_url)
      VALUES (?, ?, ?, ?, ?)
    `);
    
    stmt.run(
      userCode,
      track.id,
      track.title || '',
      track.user?.username || 'Unknown',
      track.artwork_url || ''
    );

    console.log(`✅ Сохранен трек в историю: ${track.title} для пользователя ${userCode}`);
    res.json({ success: true });
  } catch (error) {
    console.error('Ошибка при сохранении истории:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// API для получения истории прослушивания
app.get('/api/history', (req, res) => {
  try {
    const { userCode, limit = 50 } = req.query;
    
    if (!userCode) {
      return res.status(400).json({ error: 'Не указан код пользователя' });
    }

    const stmt = db.prepare(`
      SELECT track_id, track_title, artist_name, artwork_url, played_at
      FROM listening_history
      WHERE user_code = ?
      ORDER BY played_at DESC
      LIMIT ?
    `);

    const results = stmt.all(userCode, parseInt(limit));
    res.json(results);
  } catch (error) {
    console.error('Ошибка при получении истории:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// API для получения топ треков пользователя
app.get('/api/top-tracks', (req, res) => {
  try {
    const { userCode, limit = 10 } = req.query;
    
    if (!userCode) {
      return res.status(400).json({ error: 'Не указан код пользователя' });
    }

    const stmt = db.prepare(`
      SELECT track_id, track_title, artist_name, artwork_url, COUNT(*) as play_count
      FROM listening_history
      WHERE user_code = ?
      GROUP BY track_id
      ORDER BY play_count DESC, MAX(played_at) DESC
      LIMIT ?
    `);

    const results = stmt.all(userCode, parseInt(limit));
    res.json(results);
  } catch (error) {
    console.error('Ошибка при получении топ треков:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// API для получения тегов из истории
app.get('/api/history-tags', (req, res) => {
  try {
    const { userCode } = req.query;
    
    if (!userCode) {
      return res.status(400).json({ error: 'Не указан код пользователя' });
    }

    const stmt = db.prepare(`
      SELECT track_title, artist_name
      FROM listening_history
      WHERE user_code = ?
      ORDER BY played_at DESC
      LIMIT 100
    `);

    const history = stmt.all(userCode);
    const tags = new Set();

    history.forEach(item => {
      const title = (item.track_title || '').toLowerCase();
      const artist = (item.artist_name || '').toLowerCase();
      
      const keywords = [...title.split(' '), ...artist.split(' ')];
      keywords.forEach(word => {
        if (word.length > 3 && !word.match(/^(the|a|an|and|or|but|in|on|at|to|for|of|with|by)$/i)) {
          tags.add(word);
        }
      });
    });

    res.json(Array.from(tags).slice(0, 20));
  } catch (error) {
    console.error('Ошибка при получении тегов:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// API для сохранения в историю поиска
app.post('/api/search-history', (req, res) => {
  try {
    const { userCode, track } = req.body;
    
    if (!userCode || !track || !track.id) {
      return res.status(400).json({ error: 'Неверные данные' });
    }

    const stmt = db.prepare(`
      INSERT INTO search_history (user_code, track_id, track_title, artist_name, artwork_url)
      VALUES (?, ?, ?, ?, ?)
    `);
    
    stmt.run(
      userCode,
      track.id,
      track.title || '',
      track.user?.username || 'Unknown',
      track.artwork_url || ''
    );

    console.log(`✅ Сохранен трек в историю поиска: ${track.title} для пользователя ${userCode}`);
    res.json({ success: true });
  } catch (error) {
    console.error('Ошибка при сохранении истории поиска:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// API для получения истории поиска
app.get('/api/search-history', (req, res) => {
  try {
    const { userCode, limit = 50 } = req.query;
    
    if (!userCode) {
      return res.status(400).json({ error: 'Не указан код пользователя' });
    }

    const stmt = db.prepare(`
      SELECT track_id, track_title, artist_name, artwork_url, searched_at
      FROM search_history
      WHERE user_code = ?
      ORDER BY searched_at DESC
      LIMIT ?
    `);

    const results = stmt.all(userCode, parseInt(limit));
    res.json(results);
  } catch (error) {
    console.error('Ошибка при получении истории поиска:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// SoundCloud API endpoints - поиск треков для воспроизведения
app.get("/api/search", async (req, res) => {
  const q = req.query.q || "";
  const genre = req.query.genre;
  try {
    const limit = req.query.limit || 10;
    
    let url = `https://api-v2.soundcloud.com/search/tracks?client_id=${CLIENT_ID}&limit=${limit}`;
    
    // Если указан жанр, добавляем фильтр по жанру
    if (genre) {
      console.log(`🎵 Поиск треков по жанру: ${genre}`);
      url += `&filter.genre_or_tag=${encodeURIComponent(genre)}`;
    } else if (q) {
      console.log(`🔍 Поиск треков: ${q}`);
      url += `&q=${encodeURIComponent(q)}`;
    }
    
    const response = await fetch(url);
    
    if (!response.ok) {
      if (response.status === 401) {
        console.error(`❌ SoundCloud API: 401 Unauthorized - CLIENT_ID недействителен или истек`);
        console.error(`💡 Решение: получите новый CLIENT_ID на https://developers.soundcloud.com/`);
        console.error(`💡 Добавьте его в config.json как SOUNDCLOUD_CLIENT_ID`);
        return res.status(401).json({ 
          error: 'SoundCloud API: Unauthorized - CLIENT_ID недействителен',
          message: 'Получите новый CLIENT_ID на https://developers.soundcloud.com/ и добавьте в config.json как SOUNDCLOUD_CLIENT_ID'
        });
      }
      console.error(`❌ SoundCloud API вернул ошибку: ${response.status} ${response.statusText}`);
      return res.status(response.status).json({ error: `SoundCloud API error: ${response.status}` });
    }
    
    const text = await response.text();
    if (!text || text.trim() === '') {
      console.error('❌ Пустой ответ от SoundCloud API');
      return res.status(500).json({ error: 'Empty response from SoundCloud API' });
    }
    
    let data;
    try {
      data = JSON.parse(text);
    } catch (parseError) {
      console.error('❌ Ошибка парсинга JSON от SoundCloud:', parseError.message);
      console.error('Ответ:', text.substring(0, 200));
      return res.status(500).json({ error: 'Invalid JSON response from SoundCloud API' });
    }
    
    res.json(data);
  } catch (err) {
    console.error("Ошибка сервера:", err);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.get("/api/new-releases", async (req, res) => {
  try {
    console.log("Запрос на популярные последние релизы получен");
    
    const queries = ["top", "popular", "trending", "hit", "chart"];
    const allTracks = [];

    for (const query of queries) {
      try {
        const url = `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(query)}&client_id=${CLIENT_ID}&limit=30`;
        const response = await fetch(url);
        
        if (!response.ok) continue;
        
        const data = await response.json();
        if (data.collection && Array.isArray(data.collection)) {
          allTracks.push(...data.collection);
        }
      } catch (err) {
        console.error(`Ошибка при запросе "${query}":`, err.message);
      }
    }

    const uniqueTracks = Array.from(
      new Map(allTracks.map(track => [track.id, track])).values()
    );

    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 12);

    let sortedTracks = uniqueTracks
      .filter(track => {
        if (!track.created_at) return false;
        const trackDate = new Date(track.created_at);
        const hasPopularity = track.playback_count && track.playback_count > 1000;
        const isRecent = trackDate >= sixMonthsAgo;
        return isRecent && hasPopularity;
      })
      .sort((a, b) => {
        const popularityA = a.playback_count || 0;
        const popularityB = b.playback_count || 0;
        const popularityDiff = Math.abs(popularityA - popularityB) / Math.max(popularityA, popularityB);
        
        if (popularityDiff < 0.1) {
          const dateA = new Date(a.created_at);
          const dateB = new Date(b.created_at);
          return dateB - dateA;
        } else {
          return popularityB - popularityA;
        }
      })
      .slice(0, 5);

    if (sortedTracks.length < 5) {
      sortedTracks = uniqueTracks
        .filter(track => {
          if (!track.created_at) return false;
          const trackDate = new Date(track.created_at);
          const isRecent = trackDate >= sixMonthsAgo;
          return isRecent && (track.playback_count || 0) > 100;
        })
        .sort((a, b) => {
          const popularityA = a.playback_count || 0;
          const popularityB = b.playback_count || 0;
          if (Math.abs(popularityA - popularityB) / Math.max(popularityA, popularityB) < 0.1) {
            const dateA = new Date(a.created_at);
            const dateB = new Date(b.created_at);
            return dateB - dateA;
          }
          return popularityB - popularityA;
        })
        .slice(0, 5);
    }

    if (sortedTracks.length === 0) {
      sortedTracks = uniqueTracks
        .filter(track => track.playback_count && track.playback_count > 0)
        .sort((a, b) => {
          const popularityA = a.playback_count || 0;
          const popularityB = b.playback_count || 0;
          return popularityB - popularityA;
        })
        .slice(0, 5);
    }

    res.json({ collection: sortedTracks });
  } catch (err) {
    console.error("Ошибка при получении новых релизов:", err);
    res.status(500).json({ error: "Ошибка сервера", details: err.message });
  }
});

app.get('/api/stream', async (req, res) => {
  try {
    const { trackId } = req.query;

    const trackResponse = await fetch(
      `https://api-v2.soundcloud.com/tracks/${trackId}?client_id=${CLIENT_ID}`
    );
    
    if (!trackResponse.ok) {
      if (trackResponse.status === 401) {
        console.error(`❌ SoundCloud API: 401 Unauthorized для трека ${trackId} - CLIENT_ID недействителен`);
        console.error(`💡 Решение: получите новый CLIENT_ID на https://developers.soundcloud.com/`);
        return res.status(401).json({ 
          error: 'SoundCloud API: Unauthorized - CLIENT_ID недействителен',
          message: 'Получите новый CLIENT_ID на https://developers.soundcloud.com/'
        });
      }
      console.error(`❌ SoundCloud API вернул ошибку для трека ${trackId}: ${trackResponse.status}`);
      return res.status(trackResponse.status).json({ error: `SoundCloud API error: ${trackResponse.status}` });
    }
    
    const trackText = await trackResponse.text();
    if (!trackText || trackText.trim() === '') {
      console.error(`❌ Пустой ответ от SoundCloud API для трека ${trackId}`);
      return res.status(500).json({ error: 'Empty response from SoundCloud API' });
    }
    
    let track;
    try {
      track = JSON.parse(trackText);
    } catch (parseError) {
      console.error(`❌ Ошибка парсинга JSON для трека ${trackId}:`, parseError.message);
      return res.status(500).json({ error: 'Invalid JSON response from SoundCloud API' });
    }

    if (track.media && track.media.transcodings) {
      const mp3Transcoding = track.media.transcodings.find(
        t => t.format.protocol === 'progressive' && t.format.mime_type === 'audio/mpeg'
      );

      if (mp3Transcoding) {
        const streamResponse = await fetch(
          `${mp3Transcoding.url}?client_id=${CLIENT_ID}`
        );
        
        if (!streamResponse.ok) {
          console.error(`❌ Ошибка получения stream URL: ${streamResponse.status}`);
          return res.status(streamResponse.status).json({ error: 'Failed to get stream URL' });
        }
        
        const streamText = await streamResponse.text();
        if (!streamText || streamText.trim() === '') {
          console.error('❌ Пустой ответ при получении stream URL');
          return res.status(500).json({ error: 'Empty response when getting stream URL' });
        }
        
        let streamData;
        try {
          streamData = JSON.parse(streamText);
        } catch (parseError) {
          console.error('❌ Ошибка парсинга JSON для stream URL:', parseError.message);
          return res.status(500).json({ error: 'Invalid JSON response for stream URL' });
        }
        
        res.json({ streamUrl: streamData.url });
      } else {
        res.status(404).json({ error: 'Stream not found' });
      }
    } else {
      res.status(404).json({ error: 'No media available' });
    }
  } catch (error) {
    console.error('Stream error:', error);
    res.status(500).json({ error: 'Failed to get stream' });
  }
});

// Genius API endpoints
const GENIUS_ACCESS_TOKEN = '2BqLbtWrqAatlqog-Kat6QBPF-SDaUqhMEpm-Qqw7zsz7tIvTU9e8KYliVKAjmze';

app.get('/api/genius/search', async (req, res) => {
  try {
    const { q } = req.query;
    
    if (!q) {
      return res.status(400).json({ error: 'Поисковый запрос не указан' });
    }

    console.log(`🔍 Поиск текста в Genius: ${q}`);
    
    const response = await fetch(
      `https://api.genius.com/search?q=${encodeURIComponent(q)}`,
      {
        headers: {
          'Authorization': `Bearer ${GENIUS_ACCESS_TOKEN}`
        }
      }
    );

    if (!response.ok) {
      console.error(`❌ Ошибка Genius API: ${response.status} ${response.statusText}`);
      return res.status(response.status).json({ 
        error: 'Ошибка при поиске в Genius API',
        status: response.status
      });
    }

    const data = await response.json();
    console.log(`✅ Найдено результатов: ${data.response?.hits?.length || 0}`);
    
    res.json(data);
  } catch (error) {
    console.error('❌ Ошибка при поиске в Genius:', error);
    res.status(500).json({ 
      error: 'Ошибка сервера при поиске в Genius',
      details: error.message 
    });
  }
});

app.get('/api/genius/lyrics-page', async (req, res) => {
  try {
    const { url } = req.query;
    
    if (!url) {
      return res.status(400).json({ error: 'URL не указан' });
    }

    console.log(`📄 Получение текста с Genius: ${url}`);
    
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    if (!response.ok) {
      console.error(`❌ Ошибка при получении страницы: ${response.status}`);
      return res.status(response.status).json({ 
        error: 'Ошибка при получении страницы',
        status: response.status
      });
    }

    const html = await response.text();
    console.log(`✅ Получена страница, размер: ${html.length} байт`);
    
    res.json({ html });
  } catch (error) {
    console.error('❌ Ошибка при получении страницы Genius:', error);
    res.status(500).json({ 
      error: 'Ошибка сервера при получении страницы',
      details: error.message 
    });
  }
});

app.get('/api/lyrics/lrc', async (req, res) => {
  try {
    const { artist, title } = req.query;
    
    if (!artist || !title) {
      return res.status(400).json({ error: 'Артист и название трека не указаны' });
    }

    console.log(`🎵 Поиск LRC для: ${artist} - ${title}`);
    
    // Пробуем получить через lyrics.ovh
    try {
      const response = await fetch(
        `https://lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`
      );
      
      if (response.ok) {
        const data = await response.json();
        if (data.lyrics) {
          console.log(`✅ Получен текст через lyrics.ovh`);
          res.json({ lyrics: data.lyrics });
          return;
        }
      }
    } catch (error) {
      console.log('⚠️ lyrics.ovh не вернул результат:', error.message);
    }
    
    // Если lyrics.ovh не сработал, возвращаем ошибку
    res.status(404).json({ error: 'LRC текст не найден' });
  } catch (error) {
    console.error('❌ Ошибка при поиске LRC:', error);
    res.status(500).json({ 
      error: 'Ошибка сервера при поиске LRC',
      details: error.message 
    });
  }
});

// NetEase Cloud Music API endpoints
// Поиск трека в NetEase Cloud Music
app.get('/api/netease/search', async (req, res) => {
  try {
    const { s, type = 1, limit = 10 } = req.query;
    
    if (!s) {
      return res.status(400).json({ error: 'Поисковый запрос не указан' });
    }

    console.log(`🔍 Поиск в NetEase Cloud Music: ${s}`);
    
    const response = await fetch(
      `https://music.163.com/api/search/get/web?s=${encodeURIComponent(s)}&type=${type}&limit=${limit}`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          'Referer': 'https://music.163.com/'
        }
      }
    );

    if (!response.ok) {
      console.error(`❌ Ошибка NetEase API: ${response.status} ${response.statusText}`);
      return res.status(response.status).json({ 
        error: 'Ошибка при поиске в NetEase API',
        status: response.status
      });
    }

    const data = await response.json();
    console.log(`✅ Найдено результатов: ${data.result?.songCount || 0}`);
    
    res.json(data);
  } catch (error) {
    console.error('❌ Ошибка при поиске в NetEase:', error);
    res.status(500).json({ 
      error: 'Ошибка при поиске',
      details: error.message
    });
  }
});

// Получение LRC текста с таймкодами из NetEase Cloud Music
app.get('/api/netease/lyrics', async (req, res) => {
  try {
    const { id } = req.query;
    
    if (!id) {
      return res.status(400).json({ error: 'ID трека не указан' });
    }

    console.log(`📄 Получение текста из NetEase: track_id=${id}`);
    
    const response = await fetch(
      `https://music.163.com/api/song/lyric?id=${id}&lv=1&tv=1`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          'Referer': 'https://music.163.com/'
        }
      }
    );

    if (!response.ok) {
      console.error(`❌ Ошибка при получении текста: ${response.status}`);
      return res.status(response.status).json({ 
        error: 'Ошибка при получении текста',
        status: response.status
      });
    }

    const data = await response.json();
    
    // Возвращаем LRC текст (lyric - основной, tlyric - перевод)
    if (data.lrc && data.lrc.lyric) {
      console.log(`✅ Получен LRC текст для трека ${id}`);
      res.json({
        lrc: data.lrc.lyric,
        tlyric: data.tlyric?.lyric || null, // Перевод (если есть)
        id: id
      });
    } else {
      console.log(`⚠️ Текст не найден для трека ${id}`);
      res.status(404).json({ 
        error: 'Текст не найден',
        id: id
      });
    }
  } catch (error) {
    console.error('❌ Ошибка при получении текста из NetEase:', error);
    res.status(500).json({ 
      error: 'Ошибка при получении текста',
      details: error.message
    });
  }
});

// QQ Music API endpoints
// Поиск трека в QQ Music
app.get('/api/qqmusic/search', async (req, res) => {
  try {
    const { s, limit = 10 } = req.query;
    
    if (!s) {
      return res.status(400).json({ error: 'Поисковый запрос не указан' });
    }

    console.log(`🔍 Поиск в QQ Music: ${s}`);
    
    const response = await fetch(
      `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?ct=24&qqmusic_ver=1298&new_json=1&remoteplace=txt.yqq.song&searchid=&t=0&aggr=1&cr=1&catZhida=1&lossless=0&flag_qc=0&p=1&n=${limit}&w=${encodeURIComponent(s)}&g_tk=5381&loginUin=0&hostUin=0&format=json&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=0`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://y.qq.com/'
        }
      }
    );

    if (!response.ok) {
      console.error(`❌ Ошибка QQ Music API: ${response.status}`);
      return res.status(response.status).json({ 
        error: 'Ошибка при поиске в QQ Music API',
        status: response.status
      });
    }

    const data = await response.json();
    console.log(`✅ Найдено результатов в QQ Music: ${data.data?.song?.list?.length || 0}`);
    
    res.json(data);
  } catch (error) {
    console.error('❌ Ошибка при поиске в QQ Music:', error);
    res.status(500).json({ 
      error: 'Ошибка при поиске',
      details: error.message
    });
  }
});

// Получение LRC текста из QQ Music
app.get('/api/qqmusic/lyrics', async (req, res) => {
  try {
    const { songmid } = req.query;
    
    if (!songmid) {
      return res.status(400).json({ error: 'songmid не указан' });
    }

    console.log(`📄 Получение текста из QQ Music: songmid=${songmid}`);
    
    const response = await fetch(
      `https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=${songmid}&format=json&nobase64=0&musicid=0&callback=jsonp1&g_tk=5381&loginUin=0&hostUin=0&format=json&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=0`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://y.qq.com/'
        }
      }
    );

    if (!response.ok) {
      console.error(`❌ Ошибка при получении текста из QQ Music: ${response.status}`);
      return res.status(response.status).json({ 
        error: 'Ошибка при получении текста',
        status: response.status
      });
    }

    const text = await response.text();
    
    // QQ Music возвращает JSONP, нужно извлечь JSON
    let jsonData;
    try {
      // Пробуем убрать JSONP обертку
      const jsonpMatch = text.match(/jsonp1\(({.*})\)/);
      if (jsonpMatch) {
        jsonData = JSON.parse(jsonpMatch[1]);
      } else {
        // Если не JSONP, пробуем просто парсить как JSON
        jsonData = JSON.parse(text);
      }
    } catch (parseError) {
      console.error('❌ Ошибка парсинга JSONP:', parseError);
      return res.status(500).json({ 
        error: 'Ошибка парсинга ответа',
        details: parseError.message
      });
    }
    
    if (jsonData.lyric) {
      // Декодируем Base64
      try {
        const decodedLyric = Buffer.from(jsonData.lyric, 'base64').toString('utf-8');
        console.log(`✅ Получен LRC текст из QQ Music`);
        res.json({
          lrc: decodedLyric,
          songmid: songmid
        });
      } catch (decodeError) {
        console.error('❌ Ошибка декодирования Base64:', decodeError);
        res.status(500).json({ 
          error: 'Ошибка декодирования текста',
          details: decodeError.message
        });
      }
    } else {
      console.log(`⚠️ Текст не найден в QQ Music для songmid ${songmid}`);
      res.status(404).json({ 
        error: 'Текст не найден',
        songmid: songmid
      });
    }
  } catch (error) {
    console.error('❌ Ошибка при получении текста из QQ Music:', error);
    res.status(500).json({ 
      error: 'Ошибка при получении текста',
      details: error.message
    });
  }
});

// JioSaavn API endpoints
// Поиск трека в JioSaavn
app.get('/api/jiosaavn/search', async (req, res) => {
  try {
    const { q, limit = 10 } = req.query;
    
    if (!q) {
      return res.status(400).json({ error: 'Поисковый запрос не указан' });
    }

    console.log(`🔍 Поиск в JioSaavn: ${q}`);
    
    // Пробуем разные варианты API JioSaavn
    let response;
    let data;
    
    // Вариант 1: autocomplete API
    try {
      response = await fetch(
        `https://www.jiosaavn.com/api.php?__call=autocomplete.get&_format=json&_marker=0&cc=in&includeMetaTags=1&query=${encodeURIComponent(q)}`,
        {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': 'https://www.jiosaavn.com/'
          }
        }
      );

      if (response.ok) {
        data = await response.json();
        // Проверяем, есть ли результаты
        if (data.albums && data.albums.length > 0) {
          console.log(`✅ Найдено результатов в JioSaavn (autocomplete)`);
          res.json(data);
          return;
        } else if (data.songs && data.songs.length > 0) {
          console.log(`✅ Найдено результатов в JioSaavn (autocomplete)`);
          res.json(data);
          return;
        }
      }
    } catch (error) {
      console.log('⚠️ Autocomplete API не сработал, пробуем другой метод');
    }
    
    // Вариант 2: search API
    try {
      response = await fetch(
        `https://www.jiosaavn.com/api.php?__call=search.getResults&_format=json&_marker=0&cc=in&includeMetaTags=1&p=1&q=${encodeURIComponent(q)}&n=${limit}`,
        {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': 'https://www.jiosaavn.com/'
          }
        }
      );

      if (response.ok) {
        data = await response.json();
        console.log(`✅ Найдено результатов в JioSaavn (search)`);
        res.json(data);
        return;
      }
    } catch (error) {
      console.log('⚠️ Search API не сработал');
    }

    // Если оба варианта не сработали
    console.error(`❌ Ошибка JioSaavn API: ${response?.status || 'unknown'}`);
    res.status(404).json({ 
      error: 'Трек не найден в JioSaavn',
      status: response?.status || 404
    });
  } catch (error) {
    console.error('❌ Ошибка при поиске в JioSaavn:', error);
    res.status(500).json({ 
      error: 'Ошибка при поиске',
      details: error.message
    });
  }
});

// Получение LRC текста из JioSaavn
app.get('/api/jiosaavn/lyrics', async (req, res) => {
  try {
    const { id } = req.query;
    
    if (!id) {
      return res.status(400).json({ error: 'lyrics_id не указан' });
    }

    console.log(`📄 Получение текста из JioSaavn: lyrics_id=${id}`);
    
    const response = await fetch(
      `https://www.jiosaavn.com/api.php?__call=lyrics.getLyrics&lyrics_id=${id}&ctx=web6dot0&api_version=4&_format=json&_marker=0`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://www.jiosaavn.com/'
        }
      }
    );

    if (!response.ok) {
      console.error(`❌ Ошибка при получении текста из JioSaavn: ${response.status}`);
      return res.status(response.status).json({ 
        error: 'Ошибка при получении текста',
        status: response.status
      });
    }

    const data = await response.json();
    
    if (data.lyrics) {
      console.log(`✅ Получен текст из JioSaavn`);
      res.json({
        lrc: data.lyrics,
        id: id
      });
    } else {
      console.log(`⚠️ Текст не найден в JioSaavn для lyrics_id ${id}`);
      res.status(404).json({ 
        error: 'Текст не найден',
        id: id
      });
    }
  } catch (error) {
    console.error('❌ Ошибка при получении текста из JioSaavn:', error);
    res.status(500).json({ 
      error: 'Ошибка при получении текста',
      details: error.message
    });
  }
});

// MusicMatch API endpoints (web scraping, без платного API)
// Поиск трека в MusicMatch
app.get('/api/musixmatch/search', async (req, res) => {
  try {
    const { q } = req.query;
    
    if (!q) {
      return res.status(400).json({ error: 'Поисковый запрос не указан' });
    }

    console.log(`🔍 Поиск в MusicMatch: ${q}`);
    
    // MusicMatch использует поиск через URL
    const searchUrl = `https://www.musixmatch.com/search/${encodeURIComponent(q)}`;
    
    const response = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Referer': 'https://www.musixmatch.com/',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
      }
    });

    if (!response.ok) {
      console.error(`❌ Ошибка MusicMatch: ${response.status}`);
      return res.status(response.status).json({ 
        error: 'Ошибка при поиске в MusicMatch',
        status: response.status
      });
    }

    const html = await response.text();
    
    // Парсим HTML для поиска ссылок на тексты песен
    // MusicMatch обычно использует ссылки вида /lyrics/Artist/Song-Title
    const lyricsUrlPattern = /href="(\/lyrics\/[^"]+)"/g;
    const matches = [];
    let match;
    
    while ((match = lyricsUrlPattern.exec(html)) !== null && matches.length < 5) {
      matches.push(match[1]);
    }
    
    if (matches.length > 0) {
      console.log(`✅ Найдено ${matches.length} результатов в MusicMatch`);
      res.json({
        results: matches.map(url => ({
          url: `https://www.musixmatch.com${url}`
        }))
      });
    } else {
      console.log(`⚠️ Результаты не найдены в MusicMatch`);
      res.status(404).json({ error: 'Трек не найден' });
    }
  } catch (error) {
    console.error('❌ Ошибка при поиске в MusicMatch:', error);
    res.status(500).json({ 
      error: 'Ошибка при поиске',
      details: error.message
    });
  }
});

// Получение LRC текста из MusicMatch
app.get('/api/musixmatch/lyrics', async (req, res) => {
  try {
    const { url } = req.query;
    
    if (!url) {
      return res.status(400).json({ error: 'URL не указан' });
    }

    console.log(`📄 Получение текста из MusicMatch: ${url}`);
    
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Referer': 'https://www.musixmatch.com/',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
      }
    });

    if (!response.ok) {
      console.error(`❌ Ошибка при получении страницы: ${response.status}`);
      return res.status(response.status).json({ 
        error: 'Ошибка при получении страницы',
        status: response.status
      });
    }

    const html = await response.text();
    
    // Парсим HTML для извлечения текста
    // MusicMatch хранит текст в различных контейнерах
    // Пробуем найти текст в разных возможных местах
    
    let lyricsText = '';
    const lines = [];
    let match;
    
    // Вариант 1: Ищем JSON данные в скриптах (MusicMatch часто использует это)
    const scriptPattern1 = /<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/gi;
    while ((match = scriptPattern1.exec(html)) !== null) {
      try {
        const jsonData = JSON.parse(match[1]);
        // Ищем lyrics в структурированных данных
        if (jsonData.props && jsonData.props.pageProps && jsonData.props.pageProps.pageData) {
          const pageData = jsonData.props.pageProps.pageData;
          if (pageData.track && pageData.track.lyrics && pageData.track.lyrics.body) {
            const lyricsBody = pageData.track.lyrics.body;
            if (typeof lyricsBody === 'string') {
              lines.push(...lyricsBody.split('\n').map(l => l.trim()).filter(l => l));
            }
          }
        }
        // Альтернативный путь
        if (lines.length === 0 && jsonData.__NEXT_DATA__ && jsonData.__NEXT_DATA__.props) {
          const props = jsonData.__NEXT_DATA__.props;
          if (props.pageProps && props.pageProps.pageData && props.pageProps.pageData.track) {
            const track = props.pageProps.pageData.track;
            if (track.lyrics && track.lyrics.body) {
              const lyricsBody = track.lyrics.body;
              if (typeof lyricsBody === 'string') {
                lines.push(...lyricsBody.split('\n').map(l => l.trim()).filter(l => l));
              }
            }
          }
        }
      } catch (e) {
        // Игнорируем ошибки парсинга JSON
      }
    }
    
    // Вариант 2: Ищем в span с классом mxm-lyrics__content
    if (lines.length === 0) {
      const lyricsPattern1 = /<span[^>]*class="[^"]*mxm-lyrics__content[^"]*"[^>]*>([\s\S]*?)<\/span>/gi;
      while ((match = lyricsPattern1.exec(html)) !== null) {
        const lineText = match[1]
          .replace(/<[^>]+>/g, '') // Удаляем HTML теги
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/&apos;/g, "'")
          .trim();
        if (lineText && lineText.length > 0) {
          lines.push(lineText);
        }
      }
    }
    
    // Вариант 3: Ищем в div с классом, содержащим lyrics
    if (lines.length === 0) {
      const lyricsPattern2 = /<div[^>]*class="[^"]*[Ll]yrics[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
      while ((match = lyricsPattern2.exec(html)) !== null) {
        const content = match[1]
          .replace(/<script[\s\S]*?<\/script>/gi, '') // Убираем скрипты
          .replace(/<style[\s\S]*?<\/style>/gi, '') // Убираем стили
          .replace(/<[^>]+>/g, '')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .trim();
        if (content && content.length > 20) {
          const contentLines = content.split('\n').map(l => l.trim()).filter(l => l && l.length > 2);
          if (contentLines.length > 3) {
            lines.push(...contentLines);
          }
        }
      }
    }
    
    // Вариант 4: Ищем текст в data-атрибутах
    if (lines.length === 0) {
      const dataPattern = /data-lyrics="([^"]+)"/gi;
      while ((match = dataPattern.exec(html)) !== null) {
        const lyricsData = match[1]
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/&amp;/g, '&')
          .replace(/<br\s*\/?>/gi, '\n');
        if (lyricsData && lyricsData.length > 10) {
          lines.push(...lyricsData.split('\n').map(l => l.trim()).filter(l => l));
        }
      }
    }
    
    // Вариант 5: Ищем в параграфах с классом lyrics
    if (lines.length === 0) {
      const allTextPattern = /<p[^>]*class="[^"]*lyrics[^"]*"[^>]*>([\s\S]*?)<\/p>/gi;
      while ((match = allTextPattern.exec(html)) !== null) {
        const text = match[1]
          .replace(/<[^>]+>/g, '')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&#39;/g, "'")
          .trim();
        if (text && text.length > 5) {
          lines.push(text);
        }
      }
    }
    
    if (lines.length > 0) {
      lyricsText = lines.join('\n');
      console.log(`✅ Получен текст из MusicMatch, строк: ${lines.length}`);
      res.json({
        lrc: lyricsText,
        url: url,
        lines: lines.length
      });
    } else {
      console.log(`⚠️ Текст не найден на странице MusicMatch`);
      res.status(404).json({ 
        error: 'Текст не найден',
        url: url
      });
    }
  } catch (error) {
    console.error('❌ Ошибка при получении текста из MusicMatch:', error);
    res.status(500).json({ 
      error: 'Ошибка при получении текста',
      details: error.message
    });
  }
});

// ============================================================================
// Musixmatch API Community - используется ТОЛЬКО для получения текстов песен
// SoundCloud API используется для поиска и воспроизведения песен
// ============================================================================

/**
 * Получение текстов через Musixmatch Desktop API (альтернативный метод)
 * Использует desktop API endpoint с правильными заголовками
 */
async function getMusixmatchLyricsDesktopAPI(title, artist) {
  try {
    console.log(`🎵 Попытка получить текст через Musixmatch Desktop API: "${title}" - "${artist}"`);
    
    // Попробуем использовать desktop API endpoint
    const searchUrl = `https://apic-desktop.musixmatch.com/ws/1.1/track.search`;
    
    const searchResponse = await axios.get(searchUrl, {
      params: {
        q_track: title,
        q_artist: artist,
        page_size: 1,
        page: 1,
        s_track_rating: 'desc',
        f_has_lyrics: 1
      },
      headers: {
        'authority': 'apic-desktop.musixmatch.com',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'accept': 'application/json, text/plain, */*',
        'referer': 'https://www.musixmatch.com/',
        'origin': 'https://www.musixmatch.com'
      },
      timeout: 10000,
      validateStatus: () => true
    });

    if (searchResponse.status !== 200) {
      console.log(`⚠️ Musixmatch Desktop API вернул ошибку: ${searchResponse.status}`);
      return null;
    }

    const searchData = searchResponse.data;
    
    if (!searchData.message || searchData.message.header.status_code !== 200) {
      console.log(`⚠️ Musixmatch Desktop API: трек не найден`);
    return null;
  }

    const trackList = searchData.message.body?.track_list;
    if (!trackList || trackList.length === 0) {
      console.log(`⚠️ Трек не найден в Musixmatch Desktop API`);
    return null;
  }

    const track = trackList[0].track;
    const trackId = track.track_id;

    console.log(`✅ Найден трек в Musixmatch Desktop API: "${track.track_name}" - "${track.artist_name}" (ID: ${trackId})`);

    // Пробуем получить subtitle (текст с таймкодами)
    if (track.has_subtitles) {
      try {
        const subtitleUrl = `https://apic-desktop.musixmatch.com/ws/1.1/track.subtitle.get`;
        const subtitleResponse = await axios.get(subtitleUrl, {
      params: {
            track_id: trackId
      },
      headers: {
            'authority': 'apic-desktop.musixmatch.com',
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'accept': 'application/json, text/plain, */*',
            'referer': 'https://www.musixmatch.com/',
            'origin': 'https://www.musixmatch.com'
          },
          timeout: 10000,
          validateStatus: () => true
        });

        if (subtitleResponse.status === 200 && subtitleResponse.data.message?.header.status_code === 200) {
          const subtitleBody = subtitleResponse.data.message.body;
          if (subtitleBody && subtitleBody.subtitle) {
            const subtitle = subtitleBody.subtitle;
            const subtitleText = subtitle.subtitle_body;
            
            console.log(`✅ Получен текст с таймкодами из Musixmatch Desktop API (subtitle)`);
            return {
              lyrics: {
                lines: parseMusixmatchSubtitle(subtitleText),
                syncType: 'LINE_SYNCED',
                language: subtitle.subtitle_language || 'en'
              },
              source: 'Musixmatch Desktop API (subtitle)'
            };
          }
        }
      } catch (subtitleError) {
        console.log(`⚠️ Не удалось получить subtitle через Desktop API: ${subtitleError.message}`);
      }
    }

    return null;
  } catch (error) {
    console.log(`⚠️ Ошибка при запросе к Musixmatch Desktop API: ${error.message}`);
    return null;
  }
}

/**
 * Получение текстов через веб-скрапинг Musixmatch (альтернативный метод)
 * Парсит HTML страницы с текстом песни
 */
async function getMusixmatchLyricsWebScraping(title, artist) {
  try {
    console.log(`🎵 Попытка получить текст через веб-скрапинг Musixmatch: "${title}" - "${artist}"`);
    
    // Сначала ищем трек через поиск
    const searchUrl = `https://www.musixmatch.com/search/${encodeURIComponent(`${artist} ${title}`)}`;
    
    const searchResponse = await axios.get(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.musixmatch.com/'
      },
      timeout: 10000,
      validateStatus: () => true
    });

    if (searchResponse.status !== 200) {
      console.log(`⚠️ Веб-скрапинг Musixmatch: ошибка ${searchResponse.status}`);
      return null;
    }

    const html = searchResponse.data;
    
    // Ищем ссылку на страницу с текстом
    const lyricsUrlMatch = html.match(/href="(\/lyrics\/[^"]+)"/);
    if (!lyricsUrlMatch) {
      console.log(`⚠️ Веб-скрапинг Musixmatch: ссылка на текст не найдена`);
      return null;
    }

    const lyricsUrl = `https://www.musixmatch.com${lyricsUrlMatch[1]}`;
    console.log(`✅ Найдена страница с текстом: ${lyricsUrl}`);

    // Получаем страницу с текстом
    const lyricsResponse = await axios.get(lyricsUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.musixmatch.com/'
      },
      timeout: 10000,
      validateStatus: () => true
    });

    if (lyricsResponse.status !== 200) {
      console.log(`⚠️ Веб-скрапинг Musixmatch: ошибка при получении страницы ${lyricsResponse.status}`);
      return null;
    }

    const lyricsHtml = lyricsResponse.data;
    
    // Пробуем найти JSON данные с текстом и таймкодами в HTML
    // Musixmatch обычно встраивает данные в window.__mxmState или другие объекты
    let mxmStateMatch = lyricsHtml.match(/window\.__mxmState\s*=\s*({.+?});/s);
    if (!mxmStateMatch) {
      // Пробуем другой вариант
      mxmStateMatch = lyricsHtml.match(/__mxmState\s*=\s*({.+?});/s);
    }
    if (!mxmStateMatch) {
      // Пробуем найти в script тегах
      const scriptMatches = lyricsHtml.match(/<script[^>]*>([\s\S]*?window\.__mxmState[\s\S]*?)<\/script>/gi);
      if (scriptMatches) {
        for (const script of scriptMatches) {
          const stateMatch = script.match(/window\.__mxmState\s*=\s*({.+?});/s);
          if (stateMatch) {
            mxmStateMatch = stateMatch;
            break;
          }
        }
      }
    }
    
    if (mxmStateMatch) {
      try {
        const mxmState = JSON.parse(mxmStateMatch[1]);
        // Ищем данные о тексте с таймкодами в разных местах
        let lyricsBody = null;
        if (mxmState.page?.lyrics?.lyrics?.body) {
          lyricsBody = mxmState.page.lyrics.lyrics.body;
        } else if (mxmState.page?.lyrics?.body) {
          lyricsBody = mxmState.page.lyrics.body;
        } else if (mxmState.lyrics?.body) {
          lyricsBody = mxmState.lyrics.body;
        }
        
        if (lyricsBody) {
          console.log(`✅ Получен текст через веб-скрапинг Musixmatch`);
          
          // Парсим текст (может быть в разных форматах)
          const lines = parseMusixmatchWebLyrics(lyricsBody);
          
          if (lines.length > 0) {
            return {
              lyrics: {
                lines: lines,
                syncType: lines.some(l => l.startTimeMs && l.startTimeMs > 0) ? 'LINE_SYNCED' : 'UNSYNCED',
                language: 'en'
              },
              source: 'Musixmatch Web Scraping'
            };
          }
        }
      } catch (parseError) {
        console.log(`⚠️ Ошибка при парсинге mxmState: ${parseError.message}`);
      }
    }

    // Альтернативный метод: парсим текст напрямую из HTML
    // Пробуем разные селекторы
    let lyricsTextMatch = lyricsHtml.match(/<span[^>]*class="[^"]*lyrics[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    if (!lyricsTextMatch) {
      lyricsTextMatch = lyricsHtml.match(/<div[^>]*class="[^"]*lyrics[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    }
    if (!lyricsTextMatch) {
      lyricsTextMatch = lyricsHtml.match(/<p[^>]*class="[^"]*lyrics[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
    }
    
    if (lyricsTextMatch) {
      let lyricsText = lyricsTextMatch[1]
        .replace(/<[^>]+>/g, '\n')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .trim();
      
      if (lyricsText.length > 50) { // Минимальная длина текста
        console.log(`✅ Получен текст через веб-скрапинг Musixmatch (без таймкодов)`);
        
        return {
          lyrics: {
            lines: lyricsText.split('\n').filter(l => l.trim()).map(line => ({
              words: line.trim(),
              startTimeMs: 0
            })),
            syncType: 'UNSYNCED',
            language: 'en'
          },
          source: 'Musixmatch Web Scraping (unsynced)'
        };
      }
    }

    return null;
  } catch (error) {
    console.log(`⚠️ Ошибка при веб-скрапинге Musixmatch: ${error.message}`);
    return null;
  }
}

/**
 * Парсинг текста из веб-версии Musixmatch
 */
function parseMusixmatchWebLyrics(lyricsBody) {
  if (typeof lyricsBody === 'string') {
    // Если это строка, разбиваем на строки
    return lyricsBody.split('\n').filter(l => l.trim()).map(line => ({
      words: line.trim(),
      startTimeMs: 0
    }));
  } else if (Array.isArray(lyricsBody)) {
    // Если это массив объектов с таймкодами
    return lyricsBody.map(item => ({
      words: item.text || item.words || '',
      startTimeMs: item.time || item.startTimeMs || 0
    })).filter(item => item.words);
  }
  return [];
}

/**
 * Получение текстов через LRCLIB API (бесплатный API для LRC файлов)
 * LRCLIB предоставляет синхронизированные тексты (LRC формат) бесплатно
 */
async function getLRCLibLyrics(title, artist) {
  try {
    console.log(`🎵 Попытка получить текст через LRCLIB API: "${title}" - "${artist}"`);
    
    // LRCLIB API endpoint
    const searchUrl = `https://lrclib.net/api/search`;
    
    const searchResponse = await axios.get(searchUrl, {
      params: {
        q: `${artist} ${title}`,
        limit: 5
      },
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json'
      },
      timeout: 10000,
      validateStatus: () => true
    });

    if (searchResponse.status !== 200) {
      console.log(`⚠️ LRCLIB API вернул ошибку: ${searchResponse.status}`);
    return null;
  }

    const results = searchResponse.data;
    
    if (!Array.isArray(results) || results.length === 0) {
      console.log(`⚠️ LRCLIB API: треки не найдены`);
      return null;
    }

    // Находим наиболее подходящий трек
    const bestMatch = results[0];
    
    if (!bestMatch.syncedLyrics && !bestMatch.plainLyrics) {
      console.log(`⚠️ LRCLIB API: текст не найден для найденного трека`);
      return null;
    }

    console.log(`✅ Найден трек в LRCLIB: "${bestMatch.name}" - "${bestMatch.artistName}"`);
    
    // Приоритет: синхронизированный текст (с таймкодами)
    const lyricsText = bestMatch.syncedLyrics || bestMatch.plainLyrics;
    const isSynced = !!bestMatch.syncedLyrics;
    
    // Парсим LRC формат
    const lines = parseLRCLyrics(lyricsText);
    
    if (lines.length === 0) {
      console.log(`⚠️ LRCLIB API: не удалось распарсить текст`);
      return null;
    }
    
    console.log(`✅ Получен текст через LRCLIB API (${isSynced ? 'с таймкодами' : 'без таймкодов'})`);
    
    return {
      lyrics: {
        lines: lines,
        syncType: isSynced ? 'LINE_SYNCED' : 'UNSYNCED',
        language: bestMatch.lang || 'en'
      },
      source: `LRCLIB API (${isSynced ? 'synced' : 'plain'})`
    };
  } catch (error) {
    console.log(`⚠️ Ошибка при запросе к LRCLIB API: ${error.message}`);
    return null;
  }
}

/**
 * Получение текстов через NetEase Cloud Music API
 */
async function getNetEaseLyrics(title, artist) {
  try {
    console.log(`🎵 Попытка получить текст через NetEase API: "${title}" - "${artist}"`);
    
    // Сначала ищем трек
    const searchUrl = `https://music.163.com/api/search/get/web`;
    const searchResponse = await axios.get(searchUrl, {
      params: {
        s: `${artist} ${title}`,
        type: 1, // 1 = песни
        limit: 5,
        offset: 0
      },
          headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://music.163.com/'
          },
          timeout: 10000,
          validateStatus: () => true
        });
        
    if (searchResponse.status !== 200) {
      console.log(`⚠️ NetEase поиск вернул ошибку: ${searchResponse.status}`);
      return null;
    }

    const searchData = searchResponse.data;
    const songs = searchData.result?.songs;
    
    if (!songs || songs.length === 0) {
      console.log(`⚠️ NetEase: треки не найдены`);
      return null;
    }

    const song = songs[0];
    const songId = song.id;
    
    console.log(`✅ Найден трек в NetEase: "${song.name}" - "${song.artists[0]?.name}" (ID: ${songId})`);

    // Получаем текст
    const lyricsUrl = `https://music.163.com/api/song/lyric?id=${songId}&lv=1&kv=1&tv=1`;
    const lyricsResponse = await axios.get(lyricsUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://music.163.com/'
      },
      timeout: 10000,
      validateStatus: () => true
    });

    if (lyricsResponse.status !== 200) {
      console.log(`⚠️ NetEase lyrics вернул ошибку: ${lyricsResponse.status}`);
      return null;
    }

    const lyricsData = lyricsResponse.data;
    const lrcText = lyricsData.lrc?.lyric;
    
    if (!lrcText) {
      console.log(`⚠️ NetEase: текст не найден`);
      return null;
    }

    // Парсим LRC формат
    const lines = parseLRCLyrics(lrcText);
    
    if (lines.length === 0) {
      console.log(`⚠️ NetEase: не удалось распарсить текст`);
      return null;
    }
    
    const hasTimestamps = lines.some(l => l.startTimeMs && l.startTimeMs > 0);
    
    console.log(`✅ Получен текст через NetEase API (${hasTimestamps ? 'с таймкодами' : 'без таймкодов'})`);
    
            return {
              lyrics: {
        lines: lines,
        syncType: hasTimestamps ? 'LINE_SYNCED' : 'UNSYNCED',
        language: 'zh' // Китайский по умолчанию, но может быть любой
      },
      source: `NetEase Cloud Music (${hasTimestamps ? 'synced' : 'plain'})`
    };
  } catch (error) {
    console.log(`⚠️ Ошибка при запросе к NetEase API: ${error.message}`);
    return null;
  }
}

/**
 * Получение текстов через QQ Music API
 */
async function getQQMusicLyrics(title, artist) {
  try {
    console.log(`🎵 Попытка получить текст через QQ Music API: "${title}" - "${artist}"`);
    
    // Сначала ищем трек
    const searchUrl = `https://c.y.qq.com/soso/fcgi-bin/client_search_cp`;
    const searchResponse = await axios.get(searchUrl, {
      params: {
        ct: 24,
        qqmusic_ver: 1298,
        new_json: 1,
        remoteplace: 'txt.yqq.song',
        searchid: '',
        t: 0,
        aggr: 1,
        cr: 1,
        catZhida: 1,
        lossless: 0,
        flag_qc: 0,
        p: 1,
        n: 5,
        w: `${artist} ${title}`,
        g_tk: 5381,
        loginUin: 0,
        hostUin: 0,
        format: 'json',
        inCharset: 'utf8',
        outCharset: 'utf-8',
        notice: 0,
        platform: 'yqq.json',
        needNewCode: 0
      },
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://y.qq.com/'
      },
      timeout: 10000,
      validateStatus: () => true
    });

    if (searchResponse.status !== 200) {
      console.log(`⚠️ QQ Music поиск вернул ошибку: ${searchResponse.status}`);
      return null;
    }

    const searchData = searchResponse.data;
    const songs = searchData.data?.song?.list;
    
    if (!songs || songs.length === 0) {
      console.log(`⚠️ QQ Music: треки не найдены`);
      return null;
    }

    const song = songs[0];
    const songmid = song.songmid;
    
    console.log(`✅ Найден трек в QQ Music: "${song.songname}" - "${song.singer[0]?.name}" (ID: ${songmid})`);

    // Получаем текст
    const lyricsUrl = `https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg`;
    const lyricsResponse = await axios.get(lyricsUrl, {
      params: {
        songmid: songmid,
        format: 'json',
        nobase64: 0,
        musicid: 0,
        callback: 'jsonp1',
        g_tk: 5381,
        loginUin: 0,
        hostUin: 0,
        format: 'json',
        inCharset: 'utf8',
        outCharset: 'utf-8',
        notice: 0,
        platform: 'yqq.json',
        needNewCode: 0
      },
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://y.qq.com/'
      },
      timeout: 10000,
      validateStatus: () => true
    });

    if (lyricsResponse.status !== 200) {
      console.log(`⚠️ QQ Music lyrics вернул ошибку: ${lyricsResponse.status}`);
      return null;
    }

    const lyricsText = lyricsResponse.data;
    
    // QQ Music возвращает JSONP, нужно извлечь JSON
    let jsonData;
    try {
      const text = typeof lyricsText === 'string' ? lyricsText : JSON.stringify(lyricsText);
      const jsonpMatch = text.match(/jsonp1\(({.*})\)/);
      if (jsonpMatch) {
        jsonData = JSON.parse(jsonpMatch[1]);
      } else {
        jsonData = typeof lyricsText === 'object' ? lyricsText : JSON.parse(text);
      }
    } catch (parseError) {
      console.log(`⚠️ QQ Music: ошибка парсинга JSONP`);
    return null;
    }
    
    if (!jsonData.lyric) {
      console.log(`⚠️ QQ Music: текст не найден`);
        return null;
      }
      
    // Декодируем Base64
    let lrcText;
    try {
      lrcText = Buffer.from(jsonData.lyric, 'base64').toString('utf-8');
    } catch (decodeError) {
      console.log(`⚠️ QQ Music: ошибка декодирования Base64`);
      return null;
    }

    // Парсим LRC формат
    const lines = parseLRCLyrics(lrcText);
    
    if (lines.length === 0) {
      console.log(`⚠️ QQ Music: не удалось распарсить текст`);
      return null;
    }
    
    const hasTimestamps = lines.some(l => l.startTimeMs && l.startTimeMs > 0);
    
    console.log(`✅ Получен текст через QQ Music API (${hasTimestamps ? 'с таймкодами' : 'без таймкодов'})`);
    
    return {
      lyrics: {
        lines: lines,
        syncType: hasTimestamps ? 'LINE_SYNCED' : 'UNSYNCED',
        language: 'zh' // Китайский по умолчанию
      },
      source: `QQ Music (${hasTimestamps ? 'synced' : 'plain'})`
    };
  } catch (error) {
    console.log(`⚠️ Ошибка при запросе к QQ Music API: ${error.message}`);
    return null;
  }
}

/**
 * Парсинг LRC формата в массив строк с таймкодами
 */
function parseLRCLyrics(lrcText) {
  const lines = [];
  
  if (!lrcText || typeof lrcText !== 'string') {
    return lines;
  }
  
  // Паттерн для LRC: [mm:ss.xx] или [mm:ss.xxx] или [mm:ss] текст
  const lrcPattern = /\[(\d{2}):(\d{2})(?:\.(\d{2,3}))?\](.+)/g;
  let match;
  
  while ((match = lrcPattern.exec(lrcText)) !== null) {
    const minutes = parseInt(match[1]);
    const seconds = parseInt(match[2]);
    const milliseconds = match[3] ? parseInt(match[3]) : 0;
    const text = match[4].trim();
    
    if (!text) continue;
    
    // Конвертируем в миллисекунды
    let startTimeMs = (minutes * 60 + seconds) * 1000;
    
    // Обрабатываем миллисекунды (2 или 3 цифры)
    if (milliseconds > 0) {
      if (milliseconds < 100) {
        // 2 цифры = сотые доли секунды (00-99)
        startTimeMs += milliseconds * 10;
      } else {
        // 3 цифры = миллисекунды (000-999)
        startTimeMs += milliseconds;
      }
    }
    
    lines.push({
      words: text,
      startTimeMs: startTimeMs
    });
  }
  
  // Если не найдено строк с таймкодами, но есть текст, возвращаем без таймкодов
  if (lines.length === 0) {
    const textLines = lrcText.split('\n').filter(line => {
      // Пропускаем метаданные [ar:Artist], [ti:Title] и т.д.
      return line.trim() && !line.match(/^\[(ar|ti|al|by|offset):/i);
    });
    
    textLines.forEach((text, index) => {
      const cleanedText = text.replace(/\[\d{2}:\d{2}(?:\.\d{2,3})?\]/g, '').trim();
      if (cleanedText) {
        lines.push({
          words: cleanedText,
          startTimeMs: 0
        });
      }
    });
  }
  
  // Сортируем по времени
  lines.sort((a, b) => a.startTimeMs - b.startTimeMs);
  
  return lines;
}

/**
 * Получение текстов через Musixmatch API (официальный метод или альтернативные)
 * Musixmatch предоставляет тексты песен, но может не иметь таймкодов для всех песен
 * ВАЖНО: Musixmatch API используется ТОЛЬКО для текстов, НЕ для поиска треков!
 * Пробует несколько методов по очереди до получения результата
 */
async function getMusixmatchLyrics(title, artist) {
  // Метод 1: Попробуем официальный API (если ключ настроен)
  if (MUSIXMATCH_API_KEY && MUSIXMATCH_API_KEY.trim() !== '') {
    try {
      const result = await getMusixmatchLyricsOfficial(title, artist);
      if (result) return result;
    } catch (error) {
      console.log(`⚠️ Официальный API не сработал: ${error.message}`);
    }
  }

  // Метод 2: Попробуем Desktop API (бесплатный метод)
  try {
    const result = await getMusixmatchLyricsDesktopAPI(title, artist);
    if (result) return result;
  } catch (error) {
    console.log(`⚠️ Desktop API не сработал: ${error.message}`);
  }

  // Метод 3: Попробуем веб-скрапинг (бесплатный метод)
  try {
    const result = await getMusixmatchLyricsWebScraping(title, artist);
    if (result) return result;
  } catch (error) {
    console.log(`⚠️ Веб-скрапинг не сработал: ${error.message}`);
  }

  console.log(`❌ Все методы получения текста из Musixmatch не сработали`);
    return null;
  }

/**
 * Универсальная функция получения текстов с таймкодами
 * Пробует ВСЕ доступные источники по очереди
 */
async function getAllLyricsSources(title, artist) {
  const sources = [
    { name: 'LRCLIB', fn: () => getLRCLibLyrics(title, artist) },
    { name: 'NetEase', fn: () => getNetEaseLyrics(title, artist) },
    { name: 'QQ Music', fn: () => getQQMusicLyrics(title, artist) },
    { name: 'Musixmatch', fn: () => getMusixmatchLyrics(title, artist) }
  ];
  
  for (const source of sources) {
    try {
      console.log(`🔍 Пробуем источник: ${source.name}`);
      const result = await source.fn();
      if (result && result.lyrics && result.lyrics.lines && result.lyrics.lines.length > 0) {
        console.log(`✅ Успешно получен текст из источника: ${source.name}`);
        return result;
      }
    } catch (error) {
      console.log(`⚠️ Источник ${source.name} не сработал: ${error.message}`);
    }
  }
  
  return null;
}

/**
 * Получение текстов через официальный Musixmatch API
 */
async function getMusixmatchLyricsOfficial(title, artist) {
  if (!MUSIXMATCH_API_KEY || MUSIXMATCH_API_KEY.trim() === '') {
    return null;
  }

  try {
    console.log(`🎵 Поиск текста через официальный Musixmatch API: "${title}" - "${artist}"`);
    
    // Шаг 1: Поиск трека
    const searchResponse = await axios.get(`${MUSIXMATCH_API_BASE_URL}/track.search`, {
      params: {
        apikey: MUSIXMATCH_API_KEY,
        q_track: title,
        q_artist: artist,
        page_size: 1,
        page: 1,
        s_track_rating: 'desc',
        f_has_lyrics: 1
      },
      timeout: 10000,
      validateStatus: () => true
    });

    if (searchResponse.status !== 200) {
      console.log(`⚠️ Musixmatch API вернул ошибку: ${searchResponse.status}`);
      return null;
    }

    const searchData = searchResponse.data;
    
    if (searchData.message.header.status_code !== 200) {
      const statusCode = searchData.message.header.status_code;
      const hint = searchData.message.header.hint || 'Трек не найден';
      
      // Обработка ошибки 401 (неавторизован) - API ключ недействителен
      if (statusCode === 401) {
        console.error(`❌ Musixmatch API: 401 - API ключ недействителен или истек`);
        return null;
      }
      
      console.log(`⚠️ Musixmatch API: ${statusCode} - ${hint}`);
      return null;
    }

    const trackList = searchData.message.body.track_list;
    if (!trackList || trackList.length === 0) {
      console.log(`⚠️ Трек не найден в Musixmatch API`);
      return null;
    }

    const track = trackList[0].track;
    const trackId = track.track_id;
    const hasLyrics = track.has_lyrics;
    const hasSubtitles = track.has_subtitles;

    console.log(`✅ Найден трек в Musixmatch: "${track.track_name}" - "${track.artist_name}" (ID: ${trackId})`);
    console.log(`   has_lyrics: ${hasLyrics}, has_subtitles: ${hasSubtitles}`);

    // Шаг 2: Получение текста с таймкодами (если доступны)
    if (hasSubtitles) {
      try {
        const subtitleResponse = await axios.get(`${MUSIXMATCH_API_BASE_URL}/track.subtitle.get`, {
          params: {
            apikey: MUSIXMATCH_API_KEY,
            track_id: trackId
          },
          timeout: 10000,
          validateStatus: () => true
        });

        if (subtitleResponse.status === 200 && subtitleResponse.data.message.header.status_code === 200) {
          const subtitleBody = subtitleResponse.data.message.body;
          if (subtitleBody && subtitleBody.subtitle) {
            const subtitle = subtitleBody.subtitle;
            const subtitleText = subtitle.subtitle_body;
            
            // Парсим формат Musixmatch (обычно это LRC формат или похожий)
            console.log(`✅ Получен текст с таймкодами из Musixmatch (subtitle)`);
            return {
              lyrics: {
                lines: parseMusixmatchSubtitle(subtitleText),
                syncType: 'LINE_SYNCED',
                language: subtitle.subtitle_language || 'en'
              },
              source: 'Musixmatch API (subtitle)'
            };
          }
        }
      } catch (subtitleError) {
        console.log(`⚠️ Не удалось получить subtitle, пробуем обычный текст: ${subtitleError.message}`);
      }
    }

    // Шаг 3: Получение обычного текста (без таймкодов, если subtitle недоступен)
    if (hasLyrics) {
      const lyricsResponse = await axios.get(`${MUSIXMATCH_API_BASE_URL}/track.lyrics.get`, {
        params: {
          apikey: MUSIXMATCH_API_KEY,
          track_id: trackId
        },
        timeout: 10000,
        validateStatus: () => true
      });

      if (lyricsResponse.status === 200 && lyricsResponse.data.message.header.status_code === 200) {
        const lyricsBody = lyricsResponse.data.message.body;
        if (lyricsBody && lyricsBody.lyrics) {
          const lyrics = lyricsBody.lyrics;
          let lyricsText = lyrics.lyrics_body;
          
          // Убираем замечание об авторских правах в конце
          if (lyricsText.includes('******* This Lyrics is NOT for Commercial use *******')) {
            lyricsText = lyricsText.split('******* This Lyrics is NOT for Commercial use *******')[0].trim();
          }
          
          // Преобразуем текст в формат с строками
          const lines = lyricsText.split('\n').filter(line => line.trim().length > 0);
          
          console.log(`✅ Получен текст из Musixmatch (без таймкодов): ${lines.length} строк`);
          // Для текста без таймкодов используем 0, чтобы клиент мог обработать это отдельно
          // или добавляем примерные таймкоды для базовой синхронизации
          return {
            lyrics: {
              lines: lines.map((text, index) => ({
                words: text,
                startTimeMs: 0, // 0 означает отсутствие таймкодов
                // Клиент может использовать примерные таймкоды или показать текст без синхронизации
              })),
              syncType: 'UNSYNCED',
              language: lyrics.lyrics_language || 'en'
            },
            source: 'Musixmatch API (lyrics)'
          };
        }
      }
    }

    console.log(`⚠️ Текст недоступен для этого трека в Musixmatch`);
    return null;
  } catch (error) {
    if (error.response) {
      const status = error.response.status;
      const statusText = error.response.statusText;
      console.error(`❌ Ошибка Musixmatch API: ${status} ${statusText}`);
      if (error.response.data) {
        console.error(`   Детали: ${JSON.stringify(error.response.data).substring(0, 200)}`);
      }
    } else {
      console.error(`❌ Ошибка при запросе к Musixmatch API: ${error.message}`);
    }
    return null;
  }
}

/**
 * Парсинг subtitle формата Musixmatch в наш формат
 * Musixmatch обычно использует формат, похожий на LRC или собственный формат
 */
function parseMusixmatchSubtitle(subtitleText) {
  // Используем универсальный парсер LRC
  return parseLRCLyrics(subtitleText);
}

/**
 * Получение текстов с таймкодами через Suno API
 * Требует taskId и audioId (из сгенерированной музыки Suno)
 */
async function getSunoLyrics(taskId, audioId) {
  if (!SUNO_API_KEY) {
    console.log('⚠️ SUNO_API_KEY не настроен');
    return null;
  }

  if (!taskId || !audioId) {
    console.log('⚠️ Для Suno API требуется taskId и audioId');
    return null;
  }

  try {
    console.log(`🎵 Получение текста через Suno API: taskId=${taskId}, audioId=${audioId}`);
    
    const response = await axios.post(
      `${SUNO_API_BASE_URL}/api/v1/generate/get-timestamped-lyrics`,
      {
        taskId: taskId,
        audioId: audioId
      },
      {
        headers: {
          'Authorization': `Bearer ${SUNO_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 15000,
        validateStatus: () => true // Обрабатываем все статусы вручную
      }
    );

    if (response.status !== 200) {
      const errorText = response.data ? (typeof response.data === 'string' ? response.data : JSON.stringify(response.data)) : '';
      console.error(`❌ Ошибка Suno API: ${response.status} ${response.statusText}`);
      if (errorText) {
        console.error(`   Детали: ${errorText.substring(0, 300)}`);
      }
      return null;
    }

    const data = response.data;
    
    // Проверяем структуру ответа Suno API
    if (data.code === 200 && data.data && data.data.alignedWords && Array.isArray(data.data.alignedWords)) {
      const alignedWords = data.data.alignedWords;
      
      if (alignedWords.length > 0) {
        console.log(`✅ Получен текст через Suno API: ${alignedWords.length} слов/фраз`);
        return {
          alignedWords: alignedWords,
          waveformData: data.data.waveformData || [],
          source: 'Suno API'
        };
      }
    }
    
    console.log(`⚠️ Текст не найден в ответе Suno API`);
    return null;
  } catch (error) {
    if (error.response) {
      const status = error.response.status;
      const statusText = error.response.statusText;
      const errorText = error.response.data ? (typeof error.response.data === 'string' ? error.response.data : JSON.stringify(error.response.data)) : '';
      console.error(`❌ Ошибка при получении текста через Suno API: ${status} ${statusText}`);
      if (errorText) {
        console.error(`   Детали: ${errorText.substring(0, 300)}`);
      }
    } else if (error.request) {
      console.error('❌ Ошибка при получении текста через Suno API: нет ответа от сервера');
      console.error(`   Детали: ${error.message}`);
    } else {
      console.error('❌ Ошибка при получении текста через Suno API:', error.message);
    }
    return null;
  }
}

/**
 * Поиск треков в Suno API по названию и артисту
 * Возвращает audioId и taskId для получения текста
 */
async function searchSunoTrack(title, artist) {
  if (!SUNO_API_KEY) {
    console.log('⚠️ SUNO_API_KEY не настроен');
    return null;
  }

  try {
    const searchQuery = `${title} ${artist}`.trim();
    console.log(`🔍 Поиск трека в Suno API: "${searchQuery}"`);
    
    // Пробуем разные endpoints для поиска
    // Примечание: Suno API может не иметь публичного endpoint для поиска
    // В этом случае можно попробовать использовать другие методы
    
    // Вариант 1: Попробовать поиск через get-tracks endpoint (если существует)
    const response = await axios.get(
      `${SUNO_API_BASE_URL}/api/v1/tracks`,
      {
        params: {
          keyword: searchQuery,
          limit: 5
        },
        headers: {
          'Authorization': `Bearer ${SUNO_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000,
        validateStatus: () => true
      }
    );

    if (response.status === 200 && response.data) {
      const data = response.data;
      
      // Проверяем разные форматы ответа
      if (data.code === 200 && data.data) {
        const tracks = Array.isArray(data.data) ? data.data : (data.data.tracks || data.data.items || []);
        
        if (tracks.length > 0) {
          // Берем первый результат
          const track = tracks[0];
          const audioId = track.id || track.audioId || track.audio_id;
          const taskId = track.taskId || track.task_id;
          
          if (audioId && taskId) {
            console.log(`✅ Найден трек в Suno API: "${track.title || title}" (audioId: ${audioId})`);
            return { audioId, taskId, track };
          }
        }
      }
    }
    
    console.log(`⚠️ Трек не найден в Suno API для: "${title}" - "${artist}"`);
    return null;
  } catch (error) {
    // Если endpoint не существует или недоступен, это нормально
    // Suno API может не предоставлять публичный поиск
    console.log(`ℹ️ Поиск в Suno API недоступен: ${error.message}`);
    return null;
  }
}

// Musixmatch API configuration - основной источник для поиска треков и текстов
// Используем community API key из библиотеки musicxmatch-api (https://github.com/Strvm/musicxmatch-api)
// Если пользователь не указал свой ключ, используем community ключ
const MUSIXMATCH_API_KEY = process.env.MUSIXMATCH_API_KEY || '190523f64f0bab5c2d34e33b422550e7';
const MUSIXMATCH_API_BASE_URL = 'https://api.musixmatch.com/ws/1.1';
const MUSIXMATCH_USE_COMMUNITY_KEY = !process.env.MUSIXMATCH_API_KEY || process.env.MUSIXMATCH_API_KEY === '';

// Suno API configuration (опционально)
const SUNO_API_KEY = process.env.SUNO_API_KEY || '';
const SUNO_API_BASE_URL = 'https://api.sunoapi.org';

/**
 * Парсинг названия трека с дефисом
 * Формат: "artist - title" или "artist-title" или "artist – title" (en dash) или "artist — title" (em dash)
 * Возвращает {artist, title} или null если дефис не найден
 */
function parseTrackTitleWithDash(fullTitle) {
  if (!fullTitle || typeof fullTitle !== 'string') {
        return null;
  }
  
  // Нормализуем разные типы дефисов: обычный дефис (-), en dash (–), em dash (—)
  // Заменяем все на обычный дефис для упрощения парсинга
  let normalizedTitle = fullTitle
    .replace(/[\u2013\u2014]/g, '-') // Заменяем en dash и em dash на обычный дефис
    .trim();
  
  // Ищем дефис (с пробелами или без): "artist - title", "artist-title", "artist- title", "artist -title"
  // Используем паттерн, который ищет первый дефис с необязательными пробелами вокруг
  // Важно: используем нежадный квантификатор (.+?) чтобы захватить первый дефис
  const dashPattern = /^(.+?)\s*-\s*(.+)$/;
  const match = normalizedTitle.match(dashPattern);
  
  if (match && match.length === 3) {
    const artist = match[1].trim();
    const title = match[2].trim();
    
    // Проверяем, что обе части не пустые и не слишком короткие
    if (artist && title && artist.length > 0 && title.length > 0) {
      // Дополнительная проверка: если artist очень длинный (больше 100 символов), 
      // возможно это неправильный парсинг
      if (artist.length < 100 && title.length < 200) {
        return { artist, title };
      }
    }
  }
  
  return null;
}

// Получение текста с таймкодами через Musixmatch API Community
// ВАЖНО: Musixmatch API используется ТОЛЬКО для текстов песен!
// Поиск треков выполняется через SoundCloud API
// Поддерживает поиск по названию+артисту или trackId (SoundCloud)
// Пробует несколько методов: Musixmatch (официальный, Desktop API, веб-скрапинг), затем другие источники
app.get('/api/lyricstify/lyrics', async (req, res) => {
  try {
    let { trackId, title, artist } = req.query;
    
    // Если передан только trackId (SoundCloud), получаем информацию о треке из SoundCloud
    if (trackId && !title && !artist) {
      try {
        console.log(`🔍 Поиск информации о треке через SoundCloud API: trackId=${trackId}`);
        const trackResponse = await fetch(
          `https://api-v2.soundcloud.com/tracks/${trackId}?client_id=${CLIENT_ID}`
        );
        
        if (trackResponse.ok) {
          const track = await trackResponse.json();
          title = track.title;
          const soundcloudArtist = track.user?.username || track.user?.full_name || 'Unknown';
          artist = soundcloudArtist;
          
          // ВАЖНО: Если в title есть дефис (любой тип), это приоритетнее чем artist из SoundCloud
          // Потому что title часто содержит правильный формат "artist - title" или "artist-title"
          // а artist из SoundCloud может быть именем пользователя, а не настоящим артистом
          if (title && (title.includes(' - ') || title.includes('-'))) {
            const parsed = parseTrackTitleWithDash(title);
            if (parsed) {
              console.log(`📝 ВАЖНО: Распарсено из SoundCloud title (дефис обнаружен): "${title}"`);
              console.log(`   Было: artist="${soundcloudArtist}", title="${title}"`);
              console.log(`   Стало: artist="${parsed.artist}", title="${parsed.title}"`);
              artist = parsed.artist;
              title = parsed.title;
            }
          }
          
          console.log(`✅ Найден трек в SoundCloud: "${title}" - "${artist}"`);
        }
      } catch (error) {
        console.error('❌ Ошибка при получении информации о треке из SoundCloud:', error.message);
      }
    }
    
    // Если передан только trackId (Musixmatch), ищем через Musixmatch API
    if (trackId && !title && !artist && MUSIXMATCH_API_KEY) {
      try {
        console.log(`🔍 Поиск информации о треке через Musixmatch API: trackId=${trackId}`);
        const trackResponse = await axios.get(`${MUSIXMATCH_API_BASE_URL}/track.get`, {
          params: {
            apikey: MUSIXMATCH_API_KEY,
            track_id: trackId
          },
          timeout: 10000,
          validateStatus: () => true
        });

        if (trackResponse.status === 200 && trackResponse.data.message?.header.status_code === 200) {
          const track = trackResponse.data.message.body.track;
          title = track.track_name;
          artist = track.artist_name;
          console.log(`✅ Найден трек в Musixmatch: "${title}" - "${artist}"`);
        }
      } catch (error) {
        console.error('❌ Ошибка при получении информации о треке из Musixmatch:', error.message);
      }
    }
    
    // ВАЖНО: Приоритет парсинга title с дефисом
    // Если title содержит дефис (любой тип: с пробелами или без), парсим его В ЛЮБОМ СЛУЧАЕ
    // Это важно, потому что title часто содержит правильный формат "artist - title" или "artist-title"
    // а artist может быть неправильным (например, именем пользователя SoundCloud)
    
    // Проверяем наличие дефиса в title (любого типа)
    const hasDash = title && (title.includes(' - ') || title.includes('-'));
    
    if (hasDash) {
      console.log(`🔍 Обнаружен дефис в title, пытаемся распарсить: "${title}"`);
      const originalTitle = title;
      const originalArtist = artist;
      const parsed = parseTrackTitleWithDash(title);
      
      if (parsed) {
        console.log(`✅ ВАЖНО: Успешно распарсено:`);
        console.log(`   Было: artist="${originalArtist || '(не указан)'}", title="${originalTitle}"`);
        console.log(`   Стало: artist="${parsed.artist}", title="${parsed.title}"`);
        artist = parsed.artist;
        title = parsed.title;
                } else {
        console.log(`⚠️ Дефис обнаружен в title, но парсинг не удался: "${title}"`);
      }
    }
    
    // Если передан только title (без artist), пытаемся распарсить из title
    if (title && !artist) {
      const parsed = parseTrackTitleWithDash(title);
      if (parsed) {
        console.log(`📝 Распарсено из title: "${title}" -> artist: "${parsed.artist}", title: "${parsed.title}"`);
        artist = parsed.artist;
        title = parsed.title;
      }
    }
    
    // Если передан только artist (без title), но это может быть наоборот - пробуем распарсить
    if (artist && !title) {
      const parsed = parseTrackTitleWithDash(artist);
      if (parsed) {
        console.log(`📝 Распарсено из artist: "${artist}" -> artist: "${parsed.artist}", title: "${parsed.title}"`);
        artist = parsed.artist;
        title = parsed.title;
      }
    }
    
    if (!title || !artist) {
      return res.status(400).json({ 
        error: 'Не указаны title и artist',
        hint: 'Укажите title и artist для поиска текста, или trackId (SoundCloud или Musixmatch). Если в title есть дефис (например "artist - title"), он будет автоматически распарсен.'
      });
    }

    console.log(`🎵 Поиск текста для: "${title}" - "${artist}"`);
    console.log(`   Пробуем ВСЕ доступные источники по очереди:`);
    console.log(`   1) LRCLIB API (бесплатный, специализируется на LRC с таймкодами)`);
    console.log(`   2) NetEase Cloud Music (китайский сервис, часто имеет таймкоды)`);
    console.log(`   3) QQ Music (китайский сервис, часто имеет таймкоды)`);
    console.log(`   4) Musixmatch (официальный API, Desktop API, веб-скрапинг)`);
    
    // Пробуем ВСЕ источники по очереди
    let lyricsData = await getAllLyricsSources(title, artist);
    
    if (!lyricsData || !lyricsData.lyrics || !lyricsData.lyrics.lines || lyricsData.lyrics.lines.length === 0) {
      console.log(`❌ Текст не найден для: "${title}" - "${artist}"`);
      return res.status(404).json({
        error: 'Текст не найден',
        title: title,
        artist: artist,
        hint: 'Текст может быть недоступен для этого трека. Попробуйте другие источники или проверьте правильность названия и артиста.'
      });
    }

    // Преобразуем в LRC формат для совместимости
    const lrcLines = lyricsData.lyrics.lines
      .filter((line) => {
        return line.words && line.words.trim().length > 0;
      })
      .map((line) => {
        const startTime = typeof line.startTimeMs === 'string' ? parseInt(line.startTimeMs) : (line.startTimeMs || 0);
        
        // Если startTimeMs = 0 и syncType = UNSYNCED, это текст без таймкодов
        if (startTime === 0 && lyricsData.lyrics.syncType === 'UNSYNCED') {
          return line.words.trim();
        }
        
        // Формируем LRC строку с таймкодом
        const totalSeconds = startTime / 1000;
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = Math.floor(totalSeconds % 60);
        const milliseconds = Math.floor((startTime % 1000) / 10);
        return `[${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}.${milliseconds.toString().padStart(2, '0')}]${line.words.trim()}`;
      })
      .filter(line => line && line.trim().length > 0);
    
    console.log(`✅ Отправлено ${lrcLines.length} строк текста (источник: ${lyricsData.source || 'Unknown'})`);
    console.log(`   Тип синхронизации: ${lyricsData.lyrics.syncType || 'UNKNOWN'}`);
    
    res.json({
      lrc: lrcLines.join('\n'),
      trackId: trackId,
      syncType: lyricsData.lyrics.syncType || 'LINE_SYNCED',
      source: lyricsData.source || 'Unknown',
      language: lyricsData.lyrics.language || 'en'
    });
  } catch (error) {
    console.error('❌ Ошибка при получении текста:', error);
    res.status(500).json({
      error: 'Ошибка при получении текста',
      details: error.message,
      hint: 'Проверьте настройки Musixmatch API'
    });
  }
});

// Получение текстов через Suno API напрямую (по audioId и taskId)
app.get('/api/suno/lyrics', async (req, res) => {
  try {
    const { taskId, audioId } = req.query;
    
    if (!taskId || !audioId) {
      return res.status(400).json({ 
        error: 'Не указан taskId или audioId',
        hint: 'Для получения текстов через Suno API требуется taskId и audioId. Эти параметры получаются при генерации музыки через Suno API.'
      });
    }

    if (!SUNO_API_KEY) {
      return res.status(503).json({ 
        error: 'Suno API не настроен',
        hint: 'Установите SUNO_API_KEY в config.json'
      });
    }

    console.log(`🎵 Получение текста через Suno API: taskId=${taskId}, audioId=${audioId}`);
    
    const sunoData = await getSunoLyrics(taskId, audioId);
    
    if (!sunoData || !sunoData.alignedWords || sunoData.alignedWords.length === 0) {
      return res.status(404).json({
        error: 'Текст не найден в Suno API',
        taskId: taskId,
        audioId: audioId,
        hint: 'Убедитесь, что taskId и audioId корректны и текст доступен для этого трека'
      });
    }

    // Преобразуем в LRC формат
    const lrcLines = sunoData.alignedWords
      .filter((word) => word.word && (word.startS !== undefined || word.startTimeMs !== undefined))
      .map((word) => {
        let startTimeMs;
        if (word.startTimeMs !== undefined) {
          startTimeMs = typeof word.startTimeMs === 'string' ? parseInt(word.startTimeMs) : word.startTimeMs;
        } else if (word.startS !== undefined) {
          startTimeMs = Math.round((typeof word.startS === 'string' ? parseFloat(word.startS) : word.startS) * 1000);
        } else {
          return null;
        }
        
        const totalSeconds = startTimeMs / 1000;
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = Math.floor(totalSeconds % 60);
        const milliseconds = Math.floor((startTimeMs % 1000) / 10);
        return `[${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}.${milliseconds.toString().padStart(2, '0')}]${word.word}`;
      })
      .filter(line => line !== null);
    
    console.log(`✅ Отправлено ${lrcLines.length} строк текста с таймкодами через Suno API`);
    
    res.json({
      lrc: lrcLines.join('\n'),
      taskId: taskId,
      audioId: audioId,
      syncType: 'LINE_SYNCED',
      source: 'Suno API',
      language: 'en',
      alignedWords: sunoData.alignedWords,
      waveformData: sunoData.waveformData || []
    });
  } catch (error) {
    console.error('❌ Ошибка при получении текста через Suno API:', error);
    res.status(500).json({
      error: 'Ошибка при получении текста через Suno API',
      details: error.message
    });
  }
});

// ============================================================================
// API для работы с плейлистами
// ============================================================================

// Получение всех плейлистов пользователя
app.get('/api/playlists', (req, res) => {
  try {
    const { userCode } = req.query;
    
    if (!userCode) {
      return res.status(400).json({ error: 'Не указан код пользователя' });
    }

    const stmt = db.prepare(`
      SELECT p.id, p.name, p.created_at, COUNT(pt.id) as track_count
      FROM playlists p
      LEFT JOIN playlist_tracks pt ON p.id = pt.playlist_id
      WHERE p.user_code = ?
      GROUP BY p.id
      ORDER BY p.created_at DESC
    `);

    const playlists = stmt.all(userCode);
    res.json(playlists);
  } catch (error) {
    console.error('Ошибка при получении плейлистов:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Создание нового плейлиста
app.post('/api/playlists', (req, res) => {
  try {
    const { userCode, name } = req.body;
    
    if (!userCode || !name) {
      return res.status(400).json({ error: 'Не указан код пользователя или название плейлиста' });
    }

    const stmt = db.prepare('INSERT INTO playlists (user_code, name) VALUES (?, ?)');
    const result = stmt.run(userCode, name);
    
    const playlist = db.prepare('SELECT id, name, created_at FROM playlists WHERE id = ?').get(result.lastInsertRowid);
    
    console.log(`✅ Создан плейлист: ${name} для пользователя ${userCode}`);
    res.json({ ...playlist, track_count: 0 });
  } catch (error) {
    console.error('Ошибка при создании плейлиста:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Получение треков плейлиста
app.get('/api/playlists/:playlistId/tracks', (req, res) => {
  try {
    const { playlistId } = req.params;
    const { userCode } = req.query;
    
    if (!userCode) {
      return res.status(400).json({ error: 'Не указан код пользователя' });
    }

    // Проверяем, что плейлист принадлежит пользователю
    const playlistCheck = db.prepare('SELECT id FROM playlists WHERE id = ? AND user_code = ?').get(playlistId, userCode);
    if (!playlistCheck) {
      return res.status(404).json({ error: 'Плейлист не найден' });
    }

    const stmt = db.prepare(`
      SELECT track_id, track_title, artist_name, artwork_url, added_at, position
      FROM playlist_tracks
      WHERE playlist_id = ?
      ORDER BY position, added_at
    `);

    const tracks = stmt.all(playlistId);
    res.json(tracks);
  } catch (error) {
    console.error('Ошибка при получении треков плейлиста:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Добавление трека в плейлист
app.post('/api/playlists/:playlistId/tracks', (req, res) => {
  try {
    const { playlistId } = req.params;
    const { userCode, track } = req.body;
    
    if (!userCode || !track || !track.id) {
      return res.status(400).json({ error: 'Неверные данные' });
    }

    // Проверяем, что плейлист принадлежит пользователю
    const playlistCheck = db.prepare('SELECT id FROM playlists WHERE id = ? AND user_code = ?').get(playlistId, userCode);
    if (!playlistCheck) {
      return res.status(404).json({ error: 'Плейлист не найден' });
    }

    // Проверяем, нет ли уже этого трека в плейлисте
    const existing = db.prepare('SELECT id FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?').get(playlistId, track.id);
    if (existing) {
      return res.status(400).json({ error: 'Трек уже есть в плейлисте' });
    }

    // Получаем максимальную позицию
    const maxPosition = db.prepare('SELECT MAX(position) as max_pos FROM playlist_tracks WHERE playlist_id = ?').get(playlistId);
    const nextPosition = (maxPosition?.max_pos || 0) + 1;

    const stmt = db.prepare(`
      INSERT INTO playlist_tracks (playlist_id, track_id, track_title, artist_name, artwork_url, position)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run(
      playlistId,
      track.id,
      track.title || '',
      track.user?.username || 'Unknown',
      track.artwork_url || '',
      nextPosition
    );

    console.log(`✅ Добавлен трек в плейлист: ${track.title} в плейлист ${playlistId}`);
    res.json({ success: true });
  } catch (error) {
    console.error('Ошибка при добавлении трека в плейлист:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Удаление трека из плейлиста
app.delete('/api/playlists/:playlistId/tracks/:trackId', (req, res) => {
  try {
    const { playlistId, trackId } = req.params;
    const { userCode } = req.query;
    
    if (!userCode) {
      return res.status(400).json({ error: 'Не указан код пользователя' });
    }

    // Проверяем, что плейлист принадлежит пользователю
    const playlistCheck = db.prepare('SELECT id FROM playlists WHERE id = ? AND user_code = ?').get(playlistId, userCode);
    if (!playlistCheck) {
      return res.status(404).json({ error: 'Плейлист не найден' });
    }

    const stmt = db.prepare('DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?');
    stmt.run(playlistId, trackId);

    console.log(`✅ Удален трек из плейлиста: ${trackId} из плейлиста ${playlistId}`);
    res.json({ success: true });
  } catch (error) {
    console.error('Ошибка при удалении трека из плейлиста:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Изменение порядка треков в плейлисте
app.put('/api/playlists/:playlistId/reorder', (req, res) => {
  try {
    const { playlistId } = req.params;
    const { userCode, trackIds } = req.body;
    
    if (!userCode) {
      return res.status(400).json({ error: 'Не указан код пользователя' });
    }

    if (!trackIds || !Array.isArray(trackIds)) {
      return res.status(400).json({ error: 'Не указан список треков' });
    }

    // Проверяем, что плейлист принадлежит пользователю
    const playlistCheck = db.prepare('SELECT id FROM playlists WHERE id = ? AND user_code = ?').get(playlistId, userCode);
    if (!playlistCheck) {
      return res.status(404).json({ error: 'Плейлист не найден' });
    }

    // Обновляем порядок треков
    const updateStmt = db.prepare('UPDATE playlist_tracks SET position = ? WHERE playlist_id = ? AND track_id = ?');
    
    // Используем транзакцию для атомарности операции
    const updateOrder = db.transaction(() => {
      trackIds.forEach((trackId, index) => {
        updateStmt.run(index + 1, playlistId, trackId);
      });
    });
    
    updateOrder();

    console.log(`✅ Изменен порядок треков в плейлисте ${playlistId}`);
    res.json({ success: true });
  } catch (error) {
    console.error('Ошибка при изменении порядка треков:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Удаление плейлиста
app.delete('/api/playlists/:playlistId', (req, res) => {
  try {
    const { playlistId } = req.params;
    const { userCode } = req.query;
    
    if (!userCode) {
      return res.status(400).json({ error: 'Не указан код пользователя' });
    }

    // Проверяем, что плейлист принадлежит пользователю
    const playlistCheck = db.prepare('SELECT id FROM playlists WHERE id = ? AND user_code = ?').get(playlistId, userCode);
    if (!playlistCheck) {
      return res.status(404).json({ error: 'Плейлист не найден' });
    }

    const stmt = db.prepare('DELETE FROM playlists WHERE id = ?');
    stmt.run(playlistId);

    console.log(`✅ Удален плейлист: ${playlistId}`);
    res.json({ success: true });
  } catch (error) {
    console.error('Ошибка при удалении плейлиста:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ============================================================================
// API для работы с лайками
// ============================================================================

// Получение лайкнутых треков пользователя
app.get('/api/liked-tracks', (req, res) => {
  try {
    const { userCode } = req.query;
    
    if (!userCode) {
      return res.status(400).json({ error: 'Не указан код пользователя' });
    }

    const stmt = db.prepare(`
      SELECT track_id, track_title, artist_name, artwork_url, liked_at
      FROM liked_tracks
      WHERE user_code = ?
      ORDER BY liked_at DESC
    `);

    const tracks = stmt.all(userCode);
    res.json(tracks);
  } catch (error) {
    console.error('Ошибка при получении лайкнутых треков:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Добавление трека в лайки
app.post('/api/liked-tracks', (req, res) => {
  try {
    const { userCode, track } = req.body;
    
    if (!userCode || !track || !track.id) {
      return res.status(400).json({ error: 'Неверные данные' });
    }

    // Проверяем, существует ли уже трек
    const existing = db.prepare('SELECT id FROM liked_tracks WHERE user_code = ? AND track_id = ?').get(userCode, track.id);
    if (existing) {
      return res.json({ success: true, message: 'Трек уже в лайках' });
    }

    const stmt = db.prepare(`
      INSERT INTO liked_tracks (user_code, track_id, track_title, artist_name, artwork_url)
      VALUES (?, ?, ?, ?, ?)
    `);
    
    stmt.run(
      userCode,
      track.id,
      track.title || '',
      track.user?.username || 'Unknown',
      track.artwork_url || ''
    );

    console.log(`✅ Добавлен трек в лайки: ${track.title} для пользователя ${userCode}`);
    res.json({ success: true });
  } catch (error) {
    console.error('Ошибка при добавлении трека в лайки:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Удаление трека из лайков
app.delete('/api/liked-tracks/:trackId', (req, res) => {
  try {
    const { trackId } = req.params;
    const { userCode } = req.query;
    
    if (!userCode) {
      return res.status(400).json({ error: 'Не указан код пользователя' });
    }

    const stmt = db.prepare('DELETE FROM liked_tracks WHERE user_code = ? AND track_id = ?');
    stmt.run(userCode, trackId);

    console.log(`✅ Удален трек из лайков: ${trackId} для пользователя ${userCode}`);
    res.json({ success: true });
  } catch (error) {
    console.error('Ошибка при удалении трека из лайков:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Проверка, лайкнут ли трек
app.get('/api/liked-tracks/:trackId', (req, res) => {
  try {
    const { trackId } = req.params;
    const { userCode } = req.query;
    
    if (!userCode) {
      return res.status(400).json({ error: 'Не указан код пользователя' });
    }

    const stmt = db.prepare('SELECT id FROM liked_tracks WHERE user_code = ? AND track_id = ?');
    const result = stmt.get(userCode, trackId);
    
    res.json({ liked: !!result });
  } catch (error) {
    console.error('Ошибка при проверке лайка:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Обработчик 404 для несуществующих маршрутов
app.use((req, res) => {
  console.log(`⚠️ 404: Запрос на несуществующий маршрут: ${req.method} ${req.path}`);
  console.log(`   Headers:`, req.headers);
  console.log(`   Body:`, req.body);
  
  res.status(404).json({ 
    error: 'Маршрут не найден',
    path: req.path,
    method: req.method,
    server: 'main-server.js (с SQLite)',
    availableRoutes: [
      'GET  /api/test',
      'POST /api/users',
      'POST /api/history',
      'GET  /api/history',
      'GET  /api/top-tracks',
      'GET  /api/history-tags',
      'POST /api/search-history',
      'GET  /api/search-history',
      'GET  /api/search',
      'GET  /api/new-releases',
      'GET  /api/stream',
      'GET  /api/genius/search',
      'GET  /api/genius/lyrics-page',
      'GET  /api/lyrics/lrc',
      'GET  /api/netease/search',
      'GET  /api/netease/lyrics',
      'GET  /api/qqmusic/search',
      'GET  /api/qqmusic/lyrics',
      'GET  /api/jiosaavn/search',
      'GET  /api/jiosaavn/lyrics',
      'GET  /api/musixmatch/search',
      'GET  /api/musixmatch/lyrics',
      'GET  /api/lyricstify/lyrics',
      'GET  /api/playlists',
      'POST /api/playlists',
      'GET  /api/playlists/:playlistId/tracks',
      'POST /api/playlists/:playlistId/tracks',
      'DELETE /api/playlists/:playlistId/tracks/:trackId',
      'DELETE /api/playlists/:playlistId',
      'GET  /api/liked-tracks',
      'POST /api/liked-tracks',
      'DELETE /api/liked-tracks/:trackId',
      'GET  /api/liked-tracks/:trackId'
    ],
    hint: 'Убедитесь, что запущен правильный сервер: npm run server (из корня проекта)'
  });
});

const PORT = 3000;

app.listen(PORT, () => {
  console.log("\n" + "=".repeat(60));
  console.log("✅ Сервер запущен на http://localhost:" + PORT);
  console.log(`✅ База данных: ${dbPath}`);
  console.log("\n📋 Доступные маршруты:");
  console.log("  POST   /api/users          - Создать/получить пользователя");
  console.log("  POST   /api/history        - Сохранить трек в историю");
  console.log("  GET    /api/history        - Получить историю прослушивания");
  console.log("  GET    /api/top-tracks     - Получить топ треков пользователя");
  console.log("  GET    /api/history-tags   - Получить теги из истории");
  console.log("  POST   /api/search-history - Сохранить трек в историю поиска");
  console.log("  GET    /api/search-history - Получить историю поиска");
  console.log("  GET    /api/search         - Поиск треков (SoundCloud API)");
  console.log("  GET    /api/new-releases   - Новые релизы (SoundCloud API)");
  console.log("  GET    /api/stream         - Получить URL потока (SoundCloud API)");
  console.log("  GET    /api/genius/search  - Поиск текста в Genius");
  console.log("  GET    /api/genius/lyrics-page - Получить страницу с текстом");
  console.log("  GET    /api/lyrics/lrc     - Получить LRC с таймкодами");
  console.log("  GET    /api/netease/search - Поиск трека в NetEase Cloud Music");
  console.log("  GET    /api/netease/lyrics - Получить LRC текст из NetEase");
  console.log("  GET    /api/qqmusic/search - Поиск трека в QQ Music");
  console.log("  GET    /api/qqmusic/lyrics - Получить LRC текст из QQ Music");
  console.log("  GET    /api/jiosaavn/search - Поиск трека в JioSaavn");
  console.log("  GET    /api/jiosaavn/lyrics - Получить LRC текст из JioSaavn");
  console.log("  GET    /api/musixmatch/search - Поиск трека в MusicMatch (web scraping)");
  console.log("  GET    /api/musixmatch/lyrics - Получить текст из MusicMatch (web scraping)");
  console.log("  GET    /api/lyricstify/lyrics - Получить текст с таймкодами через Musixmatch API Community");
  console.log("  GET    /api/playlists - Получить все плейлисты пользователя");
  console.log("  POST   /api/playlists - Создать новый плейлист");
  console.log("  GET    /api/playlists/:playlistId/tracks - Получить треки плейлиста");
  console.log("  POST   /api/playlists/:playlistId/tracks - Добавить трек в плейлист");
  console.log("  DELETE /api/playlists/:playlistId/tracks/:trackId - Удалить трек из плейлиста");
  console.log("  DELETE /api/playlists/:playlistId - Удалить плейлист");
  console.log("  GET    /api/liked-tracks - Получить лайкнутые треки");
  console.log("  POST   /api/liked-tracks - Добавить трек в лайки");
  console.log("  DELETE /api/liked-tracks/:trackId - Удалить трек из лайков");
  console.log("  GET    /api/liked-tracks/:trackId - Проверить, лайкнут ли трек");
  console.log("\n📋 Конфигурация:");
  console.log(`     ✅ SoundCloud API - используется для поиска и воспроизведения песен`);
  console.log(`     📝 Musixmatch API - используется ТОЛЬКО для получения текстов песен`);
  
  if (MUSIXMATCH_USE_COMMUNITY_KEY) {
    console.log(`     ⚠️  Musixmatch API: используется community ключ`);
    console.log(`        ⚠️  ВНИМАНИЕ: Community ключ может не работать (ошибка 401)!`);
    console.log(`        💡 РЕШЕНИЕ: получите БЕСПЛАТНЫЙ API ключ на https://developer.musixmatch.com/`);
    console.log(`        💡 Добавьте его в config.json: "MUSIXMATCH_API_KEY": "ваш_ключ"`);
    console.log(`        📝 Подробная инструкция: см. MUSIXMATCH_API_KEY_SETUP.md`);
    console.log(`        ⚠️  БЕЗ API КЛЮЧА ТЕКСТЫ ПЕСЕН НЕ БУДУТ РАБОТАТЬ!`);
  } else if (MUSIXMATCH_API_KEY && MUSIXMATCH_API_KEY.trim() !== '') {
    console.log(`     ✅ Musixmatch API настроен - используется пользовательский ключ (БЕЗ COOKIE!)`);
    console.log(`        ⭐ Используется ТОЛЬКО для получения текстов песен`);
  } else {
    console.log(`     ❌ Musixmatch API не настроен`);
    console.log(`        💡 ОБЯЗАТЕЛЬНО: получите БЕСПЛАТНЫЙ API ключ на https://developer.musixmatch.com/`);
    console.log(`        💡 Добавьте его в config.json: "MUSIXMATCH_API_KEY": "ваш_ключ"`);
    console.log(`        📝 Подробная инструкция: см. MUSIXMATCH_API_KEY_SETUP.md`);
    console.log(`        ⚠️  БЕЗ API КЛЮЧА ТЕКСТЫ ПЕСЕН НЕ БУДУТ РАБОТАТЬ!`);
  }
  
  if (SUNO_API_KEY) {
    console.log(`     ✅ Suno API настроен - получение текстов через Suno API доступно`);
    console.log(`        Примечание: Suno API работает с музыкой, сгенерированной через их платформу`);
  } else {
    console.log(`     ℹ️  Suno API не настроен (опционально)`);
    console.log(`        Для использования Suno API установите SUNO_API_KEY в config.json`);
  }
  
  console.log();
  
  console.log("=".repeat(60) + "\n");
});

