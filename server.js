import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(cors());

const CLIENT_ID = "2P4wPAEAHIUORn2tAOr4cXSv6Cb5tuIB";

app.get("/api/search", async (req, res) => {
    const q = req.query.q || "";
    try {
        const limit = req.query.limit || 10;
        const response = await fetch(
            `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(q)}&client_id=${CLIENT_ID}&limit=${limit}`
        );
        const data = await response.json();
        res.json(data);
    } catch (err) {
        console.error("Ошибка сервера:", err);
        res.status(500).json({ error: "Ошибка сервера" });
    }
});

app.get("/api/new-releases", async (req, res) => {
    try {
        console.log("Запрос на популярные последние релизы получен");
        
        // Используем популярные поисковые запросы, которые обычно возвращают популярные треки
        const queries = ["top", "popular", "trending", "hit", "chart"];
        const allTracks = [];

        for (const query of queries) {
            try {
                const url = `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(query)}&client_id=${CLIENT_ID}&limit=30`;
                console.log(`Запрос к SoundCloud: ${query}`);
                
                const response = await fetch(url);
                
                if (!response.ok) {
                    console.error(`HTTP ошибка для "${query}":`, response.status, response.statusText);
                    continue;
                }
                
                const data = await response.json();
                console.log(`Получено треков для "${query}":`, data.collection?.length || 0);
                
                if (data.collection && Array.isArray(data.collection)) {
                    allTracks.push(...data.collection);
                }
            } catch (err) {
                console.error(`Ошибка при запросе "${query}":`, err.message);
            }
        }

        console.log(`Всего получено треков: ${allTracks.length}`);

        // Убираем дубликаты по ID
        const uniqueTracks = Array.from(
            new Map(allTracks.map(track => [track.id, track])).values()
        );

        console.log(`Уникальных треков: ${uniqueTracks.length}`);

        // Фильтруем только недавние треки (за последние 12 месяцев) и с высокой популярностью
        const sixMonthsAgo = new Date();
        sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 12);

        // Сортируем по комбинации популярности (playback_count) и свежести (created_at)
        let sortedTracks = uniqueTracks
            .filter(track => {
                // Фильтруем только треки с датой и с минимум 1000 прослушиваний
                if (!track.created_at) return false;
                const trackDate = new Date(track.created_at);
                const hasPopularity = track.playback_count && track.playback_count > 1000;
                const isRecent = trackDate >= sixMonthsAgo;
                return isRecent && hasPopularity;
            })
            .sort((a, b) => {
                // Сначала по популярности (playback_count), затем по дате
                const popularityA = a.playback_count || 0;
                const popularityB = b.playback_count || 0;
                
                // Если разница в популярности невелика (менее 10%), сортируем по дате
                const popularityDiff = Math.abs(popularityA - popularityB) / Math.max(popularityA, popularityB);
                
                if (popularityDiff < 0.1) {
                    // Похожая популярность - сортируем по дате (новые первыми)
                    const dateA = new Date(a.created_at);
                    const dateB = new Date(b.created_at);
                    return dateB - dateA;
                } else {
                    // Разная популярность - сортируем по популярности (больше первыми)
                    return popularityB - popularityA;
                }
            })
            .slice(0, 5); // Берем только 5 самых популярных недавних

        console.log(`Отфильтровано треков (недавние и популярные): ${sortedTracks.length}`);
        
        // Если после фильтрации пусто, ослабляем критерии
        if (sortedTracks.length < 5) {
            console.log("Мало результатов, ослабляем критерии фильтрации");
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
        
        // Если всё ещё пусто, берём просто самые популярные из всех
        if (sortedTracks.length === 0) {
            console.log("Берём самые популярные из всех треков");
            sortedTracks = uniqueTracks
                .filter(track => track.playback_count && track.playback_count > 0)
                .sort((a, b) => {
                    const popularityA = a.playback_count || 0;
                    const popularityB = b.playback_count || 0;
                    return popularityB - popularityA;
                })
                .slice(0, 5);
        }

        console.log(`Отправляем ${sortedTracks.length} самых популярных последних треков`);

        res.json({ collection: sortedTracks });
    } catch (err) {
        console.error("Ошибка при получении новых релизов:", err);
        res.status(500).json({ error: "Ошибка сервера", details: err.message });
    }
});

// Добавьте этот эндпоинт в ваш server.js

app.get('/api/stream', async (req, res) => {
    try {
        const { trackId } = req.query;

        // Получаем информацию о треке
        const trackResponse = await fetch(
            `https://api-v2.soundcloud.com/tracks/${trackId}?client_id=${CLIENT_ID}`
        );
        const track = await trackResponse.json();

        // Получаем транскодинги (различные качества аудио)
        if (track.media && track.media.transcodings) {
            // Ищем HTTP MP3 stream (самый совместимый формат)
            const mp3Transcoding = track.media.transcodings.find(
                t => t.format.protocol === 'progressive' && t.format.mime_type === 'audio/mpeg'
            );

            if (mp3Transcoding) {
                // Получаем финальный URL
                const streamResponse = await fetch(
                    `${mp3Transcoding.url}?client_id=${CLIENT_ID}`
                );
                const streamData = await streamResponse.json();

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

app.listen(3000, () => console.log("✅ Proxy запущен на http://localhost:3000"));
