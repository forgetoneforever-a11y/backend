require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const TelegramBot = require("node-telegram-bot-api");

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "10mb" }));

// Подключение к Neon
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Telegram-бот для уведомлений
const bot = process.env.BOT_TOKEN
    ? new TelegramBot(process.env.BOT_TOKEN, { polling: false })
    : null;

if (!bot) console.warn("BOT_TOKEN не задан — уведомления не будут отправляться");

// Создать таблицы при старте
async function initDb() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            telegram_id TEXT UNIQUE,
            username TEXT,
            name TEXT NOT NULL,
            nickname TEXT,
            city TEXT,
            age INTEGER,
            gender TEXT,
            looking_for TEXT,
            min_age INTEGER,
            max_age INTEGER,
            bio TEXT,
            photo TEXT,
            banner TEXT DEFAULT 'default',
            likes_received INTEGER DEFAULT 0,
            dislikes_received INTEGER DEFAULT 0,
            language TEXT DEFAULT 'ru',
            created_at TIMESTAMP DEFAULT NOW()
        );
    `);

    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS city TEXT;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS banner TEXT DEFAULT 'default';`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS likes_received INTEGER DEFAULT 0;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS dislikes_received INTEGER DEFAULT 0;`);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS likes (
            id SERIAL PRIMARY KEY,
            from_user TEXT NOT NULL,
            to_user TEXT NOT NULL,
            is_like BOOLEAN DEFAULT TRUE,
            created_at TIMESTAMP DEFAULT NOW(),
            UNIQUE(from_user, to_user)
        );
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS messages (
            id SERIAL PRIMARY KEY,
            from_user TEXT NOT NULL,
            to_user TEXT NOT NULL,
            text TEXT NOT NULL,
            is_read BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMP DEFAULT NOW()
        );
    `);

    console.log("База готова");
}
initDb().catch(console.error);

// Проверка
app.get("/", (req, res) => res.send("Ember API работает"));

// Регистрация
app.post("/api/register", async (req, res) => {
    try {
        const { telegram_id, username, name, nickname, city, age, gender, looking_for, min_age, max_age, bio, photo, banner, language } = req.body;

        if (!name) return res.status(400).json({ error: "Имя обязательно" });
        if (age && age < 13) return res.status(400).json({ error: "Минимальный возраст — 13 лет" });

        const result = await pool.query(`
            INSERT INTO users (telegram_id, username, name, nickname, city, age, gender, looking_for, min_age, max_age, bio, photo, banner, language)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
            ON CONFLICT (telegram_id) DO UPDATE SET
                username = EXCLUDED.username,
                name = EXCLUDED.name,
                nickname = EXCLUDED.nickname,
                city = EXCLUDED.city,
                age = EXCLUDED.age,
                gender = EXCLUDED.gender,
                looking_for = EXCLUDED.looking_for,
                min_age = EXCLUDED.min_age,
                max_age = EXCLUDED.max_age,
                bio = EXCLUDED.bio,
                photo = EXCLUDED.photo,
                banner = EXCLUDED.banner,
                language = EXCLUDED.language
            RETURNING *;
        `, [telegram_id, username, name, nickname, city, age, gender, looking_for, min_age, max_age, bio, photo, banner || 'default', language]);

        res.json({ ok: true, user: result.rows[0] });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
});

// Получить свой профиль
app.get("/api/profile", async (req, res) => {
    try {
        const { telegram_id } = req.query;
        if (!telegram_id) return res.status(400).json({ error: "telegram_id обязателен" });

        const result = await pool.query(
            "SELECT * FROM users WHERE telegram_id = $1",
            [telegram_id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Профиль не найден" });
        }

        res.json(result.rows[0]);
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
});

// Обновить профиль
app.put("/api/profile", async (req, res) => {
    try {
        const { telegram_id, name, nickname, city, age, gender, looking_for, min_age, max_age, bio, photo, banner, language } = req.body;

        if (!telegram_id) return res.status(400).json({ error: "telegram_id обязателен" });
        if (age && age < 13) return res.status(400).json({ error: "Минимальный возраст — 13 лет" });

        const result = await pool.query(`
            UPDATE users SET
                name = COALESCE($2, name),
                nickname = $3,
                city = $4,
                age = COALESCE($5, age),
                gender = COALESCE($6, gender),
                looking_for = COALESCE($7, looking_for),
                min_age = COALESCE($8, min_age),
                max_age = COALESCE($9, max_age),
                bio = $10,
                photo = COALESCE($11, photo),
                banner = COALESCE($12, banner),
                language = COALESCE($13, language)
            WHERE telegram_id = $1
            RETURNING *;
        `, [telegram_id, name, nickname, city, age, gender, looking_for, min_age, max_age, bio, photo, banner, language]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Профиль не найден" });
        }

        console.log(`✏️ Профиль обновлён: ${telegram_id}`);
        res.json({ ok: true, user: result.rows[0] });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
});

// Удалить аккаунт
app.delete("/api/profile", async (req, res) => {
    try {
        const { telegram_id } = req.body;
        if (!telegram_id) return res.status(400).json({ error: "telegram_id обязателен" });

        await pool.query("DELETE FROM likes WHERE from_user = $1 OR to_user = $1", [telegram_id]);
        await pool.query("DELETE FROM messages WHERE from_user = $1 OR to_user = $1", [telegram_id]);
        await pool.query("DELETE FROM users WHERE telegram_id = $1", [telegram_id]);

        console.log(`🗑️ Аккаунт удалён: ${telegram_id}`);
        res.json({ ok: true, message: "Аккаунт удалён" });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
});

// Рекомендации
app.get("/api/recommendations", async (req, res) => {
    try {
        const { telegram_id, looking_for, min_age, max_age } = req.query;

        let query = `SELECT * FROM users 
            WHERE telegram_id != $1 
            AND telegram_id NOT IN (
                SELECT to_user FROM likes WHERE from_user = $1
            )
            AND telegram_id NOT IN (
                SELECT from_user FROM likes WHERE to_user = $1
            )`;
        const params = [telegram_id || ""];
        let i = 2;

        if (looking_for && looking_for !== "any") {
            query += ` AND gender = $${i++}`;
            params.push(looking_for);
        }
        if (min_age) {
            query += ` AND age >= $${i++}`;
            params.push(min_age);
        }
        if (max_age) {
            query += ` AND age <= $${i++}`;
            params.push(max_age);
        }

        query += " ORDER BY created_at DESC LIMIT 50";

        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
});

// Лайк/дизлайк
app.post("/api/likes", async (req, res) => {
    try {
        const { from_user, to_user, is_like } = req.body;

        if (!from_user || !to_user) {
            return res.status(400).json({ error: "from_user и to_user обязательны" });
        }

        const existing = await pool.query(
            "SELECT is_like FROM likes WHERE from_user = $1 AND to_user = $2",
            [from_user, to_user]
        );
        const hadInteraction = existing.rows.length > 0;
        const wasLiked = existing.rows[0]?.is_like;

        await pool.query(`
            INSERT INTO likes (from_user, to_user, is_like)
            VALUES ($1, $2, $3)
            ON CONFLICT (from_user, to_user) DO UPDATE SET is_like = EXCLUDED.is_like
        `, [from_user, to_user, is_like]);

        if (!hadInteraction) {
            if (is_like) {
                await pool.query(
                    "UPDATE users SET likes_received = likes_received + 1 WHERE telegram_id = $1",
                    [to_user]
                );
            } else {
                await pool.query(
                    "UPDATE users SET dislikes_received = dislikes_received + 1 WHERE telegram_id = $1",
                    [to_user]
                );
            }
        } else if (wasLiked !== is_like) {
            if (is_like) {
                await pool.query(
                    "UPDATE users SET likes_received = likes_received + 1, dislikes_received = GREATEST(0, dislikes_received - 1) WHERE telegram_id = $1",
                    [to_user]
                );
            } else {
                await pool.query(
                    "UPDATE users SET dislikes_received = dislikes_received + 1, likes_received = GREATEST(0, likes_received - 1) WHERE telegram_id = $1",
                    [to_user]
                );
            }
        }

        let isMatch = false;
        let matchedUser = null;

        if (is_like) {
            const mutual = await pool.query(`
                SELECT * FROM likes
                WHERE from_user = $1 AND to_user = $2 AND is_like = TRUE
            `, [to_user, from_user]);

            if (mutual.rows.length > 0) {
                isMatch = true;

                const userData = await pool.query(
                    "SELECT telegram_id, username, name, age, city, photo, bio, banner FROM users WHERE telegram_id = $1",
                    [to_user]
                );
                matchedUser = userData.rows[0];

                console.log(`МЭТЧ: ${from_user} <-> ${to_user}`);
            }
        }

        res.json({ ok: true, isMatch, matchedUser });

        setImmediate(async () => {
            try {
                if (!bot) return;
                const [myRes, theirRes] = await Promise.all([
                    pool.query("SELECT name, age FROM users WHERE telegram_id = $1", [from_user]),
                    pool.query("SELECT name, age FROM users WHERE telegram_id = $1", [to_user])
                ]);
                const mine = myRes.rows[0];
                const theirs = theirRes.rows[0];
                if (!mine || !theirs) return;

                if (is_like && isMatch) {
                    await bot.sendMessage(to_user, `💕 <b>Это мэтч!</b>\n\n${mine.name}, ${mine.age} тоже тебя лайкнул(а).\n\n👉 Открой Ember, чтобы написать первым!`, { parse_mode: "HTML" }).catch(() => {});
                    await bot.sendMessage(from_user, `💕 <b>Это мэтч!</b>\n\n${theirs.name}, ${theirs.age} тоже тебя лайкнул(а).\n\n👉 Открой Ember, чтобы написать первым!`, { parse_mode: "HTML" }).catch(() => {});
                } else if (is_like) {
                    await bot.sendMessage(to_user, `💗 <b>Тебя лайкнул(а) ${mine.name}, ${mine.age}</b>\n\n👉 Открой Ember, чтобы ответить взаимностью!`, { parse_mode: "HTML" }).catch(() => {});
                }
            } catch (e) {
                console.error("Bot error:", e.message);
            }
        });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
});

// Кто меня лайкнул — ДОБАВЛЕН banner
app.get("/api/likes/incoming", async (req, res) => {
    try {
        const { telegram_id } = req.query;
        if (!telegram_id) return res.status(400).json({ error: "telegram_id обязателен" });

        const result = await pool.query(`
            SELECT u.telegram_id, u.username, u.name, u.age, u.city, u.photo, u.bio, u.banner, u.gender
            FROM users u
            INNER JOIN likes l ON l.from_user = u.telegram_id
            WHERE l.to_user = $1
              AND l.is_like = TRUE
              AND NOT EXISTS (
                  SELECT 1 FROM likes l2
                  WHERE l2.from_user = $1 AND l2.to_user = u.telegram_id
              )
            ORDER BY l.created_at DESC
        `, [telegram_id]);

        res.json(result.rows);
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
});

// Кого я лайкнул — ДОБАВЛЕН banner
app.get("/api/likes/outgoing", async (req, res) => {
    try {
        const { telegram_id } = req.query;
        if (!telegram_id) return res.status(400).json({ error: "telegram_id обязателен" });

        const result = await pool.query(`
            SELECT 
                u.telegram_id, u.username, u.name, u.age, u.city, u.photo, u.bio, u.banner, u.gender,
                EXISTS(
                    SELECT 1 FROM likes l2 
                    WHERE l2.from_user = u.telegram_id 
                      AND l2.to_user = $1 
                      AND l2.is_like = TRUE
                ) AS is_mutual
            FROM users u
            INNER JOIN likes l ON l.to_user = u.telegram_id
            WHERE l.from_user = $1 AND l.is_like = TRUE
            ORDER BY l.created_at DESC
        `, [telegram_id]);

        res.json(result.rows);
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
});

// Отменить лайк
app.delete("/api/likes", async (req, res) => {
    try {
        const { from_user, to_user } = req.body;

        if (!from_user || !to_user) {
            return res.status(400).json({ error: "from_user и to_user обязательны" });
        }

        const existing = await pool.query(
            "SELECT is_like FROM likes WHERE from_user = $1 AND to_user = $2",
            [from_user, to_user]
        );

        if (existing.rows.length > 0) {
            if (existing.rows[0].is_like) {
                await pool.query(
                    "UPDATE users SET likes_received = GREATEST(0, likes_received - 1) WHERE telegram_id = $1",
                    [to_user]
                );
            } else {
                await pool.query(
                    "UPDATE users SET dislikes_received = GREATEST(0, dislikes_received - 1) WHERE telegram_id = $1",
                    [to_user]
                );
            }
        }

        await pool.query(
            "DELETE FROM likes WHERE from_user = $1 AND to_user = $2",
            [from_user, to_user]
        );

        console.log(`❌ Лайк отменён: ${from_user} -> ${to_user}`);
        res.json({ ok: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
});

// Мои мэтчи — ДОБАВЛЕН banner
app.get("/api/matches", async (req, res) => {
    try {
        const { telegram_id } = req.query;
        if (!telegram_id) return res.status(400).json({ error: "telegram_id обязателен" });

        const result = await pool.query(`
            SELECT 
                u.telegram_id, u.username, u.name, u.age, u.city, u.photo, u.bio, u.banner, u.gender
            FROM users u
            WHERE u.telegram_id IN (
                SELECT CASE 
                    WHEN l1.from_user = $1 THEN l1.to_user
                    ELSE l1.from_user
                END
                FROM likes l1
                INNER JOIN likes l2 
                    ON l1.from_user = l2.to_user 
                    AND l1.to_user = l2.from_user
                WHERE (l1.from_user = $1 OR l1.to_user = $1)
                    AND l1.is_like = TRUE 
                    AND l2.is_like = TRUE
            )
        `, [telegram_id]);

        res.json(result.rows);
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
});

// Отправить сообщение
app.post("/api/messages", async (req, res) => {
    try {
        const { from_user, to_user, text } = req.body;

        if (!from_user || !to_user || !text) {
            return res.status(400).json({ error: "from_user, to_user и text обязательны" });
        }

        const result = await pool.query(`
            INSERT INTO messages (from_user, to_user, text)
            VALUES ($1, $2, $3)
            RETURNING *;
        `, [from_user, to_user, text]);

        res.json({ ok: true, message: result.rows[0] });

        setImmediate(async () => {
            try {
                if (!bot) return;
                const sender = await pool.query(
                    "SELECT name, age FROM users WHERE telegram_id = $1",
                    [from_user]
                );
                const s = sender.rows[0];
                if (s) {
                    await bot.sendMessage(
                        to_user,
                        `💬 <b>Новое сообщение от ${s.name}, ${s.age}:</b>\n\n${text}\n\n👉 Открой Ember, чтобы ответить!`,
                        { parse_mode: "HTML" }
                    ).catch(() => {});
                }
            } catch (e) {
                console.error("Bot error:", e.message);
            }
        });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
});

// История чата
app.get("/api/messages", async (req, res) => {
    try {
        const { user1, user2 } = req.query;
        if (!user1 || !user2) return res.status(400).json({ error: "user1 и user2 обязательны" });

        const result = await pool.query(`
            SELECT * FROM messages
            WHERE (from_user = $1 AND to_user = $2)
               OR (from_user = $2 AND to_user = $1)
            ORDER BY created_at ASC
            LIMIT 200
        `, [user1, user2]);

        await pool.query(`
            UPDATE messages SET is_read = TRUE
            WHERE from_user = $1 AND to_user = $2
        `, [user2, user1]);

        res.json(result.rows);
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
});

// Только новые сообщения
app.get("/api/messages/since", async (req, res) => {
    try {
        const { user1, user2, since_id } = req.query;
        if (!user1 || !user2) return res.status(400).json({ error: "user1 и user2 обязательны" });

        const result = await pool.query(`
            SELECT * FROM messages
            WHERE ((from_user = $1 AND to_user = $2) OR (from_user = $2 AND to_user = $1))
              AND id > $3
            ORDER BY created_at ASC
            LIMIT 50
        `, [user1, user2, parseInt(since_id) || 0]);

        if (result.rows.length > 0) {
            pool.query(`
                UPDATE messages SET is_read = TRUE
                WHERE from_user = $1 AND to_user = $2 AND is_read = FALSE
            `, [user2, user1]).catch(() => {});
        }

        res.json(result.rows);
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
});

// Непрочитанные
app.get("/api/messages/unread", async (req, res) => {
    try {
        const { telegram_id } = req.query;
        if (!telegram_id) return res.status(400).json({ error: "telegram_id обязателен" });

        const result = await pool.query(`
            SELECT from_user, COUNT(*) as count
            FROM messages
            WHERE to_user = $1 AND is_read = FALSE
            GROUP BY from_user
        `, [telegram_id]);

        res.json(result.rows);
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
});

app.listen(port, () => {
    console.log(`Сервер запущен на порту ${port}`);
});
