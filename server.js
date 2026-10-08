require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "10mb" }));

// Подключение к Neon
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Создать таблицы при старте
async function initDb() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            telegram_id TEXT UNIQUE,
            name TEXT NOT NULL,
            nickname TEXT,
            age INTEGER,
            gender TEXT,
            looking_for TEXT,
            min_age INTEGER,
            max_age INTEGER,
            bio TEXT,
            photo TEXT,
            language TEXT DEFAULT 'ru',
            created_at TIMESTAMP DEFAULT NOW()
        );
    `);

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

    console.log("База готова");
}
initDb().catch(console.error);

// Проверка
app.get("/", (req, res) => res.send("Ember API работает"));

// Регистрация — сохранить анкету
app.post("/api/register", async (req, res) => {
    try {
        const { telegram_id, name, nickname, age, gender, looking_for, min_age, max_age, bio, photo, language } = req.body;

        if (!name) return res.status(400).json({ error: "Имя обязательно" });

        const result = await pool.query(`
            INSERT INTO users (telegram_id, name, nickname, age, gender, looking_for, min_age, max_age, bio, photo, language)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            ON CONFLICT (telegram_id) DO UPDATE SET
                name = EXCLUDED.name,
                nickname = EXCLUDED.nickname,
                age = EXCLUDED.age,
                gender = EXCLUDED.gender,
                looking_for = EXCLUDED.looking_for,
                min_age = EXCLUDED.min_age,
                max_age = EXCLUDED.max_age,
                bio = EXCLUDED.bio,
                photo = EXCLUDED.photo,
                language = EXCLUDED.language
            RETURNING *;
        `, [telegram_id, name, nickname, age, gender, looking_for, min_age, max_age, bio, photo, language]);

        res.json({ ok: true, user: result.rows[0] });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
});

// Получить анкеты (кроме своей)
app.get("/api/recommendations", async (req, res) => {
    try {
        const { telegram_id, looking_for, min_age, max_age } = req.query;

        let query = "SELECT * FROM users WHERE telegram_id != $1";
        const params = [telegram_id || ""];
        let i = 2;

        // Фильтр по полу (кого я ищу)
        if (looking_for && looking_for !== "any") {
            query += ` AND gender = $${i++}`;
            params.push(looking_for);
        }

        // Фильтр по возрасту
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

// Поставить лайк/дизлайк и проверить взаимность
app.post("/api/likes", async (req, res) => {
    try {
        const { from_user, to_user, is_like } = req.body;

        if (!from_user || !to_user) {
            return res.status(400).json({ error: "from_user и to_user обязательны" });
        }

        // Сохраняем лайк
        await pool.query(`
            INSERT INTO likes (from_user, to_user, is_like)
            VALUES ($1, $2, $3)
            ON CONFLICT (from_user, to_user) DO UPDATE SET is_like = EXCLUDED.is_like
        `, [from_user, to_user, is_like]);

        // Проверяем взаимность
        let isMatch = false;
        let matchedUser = null;

        if (is_like) {
            const mutual = await pool.query(`
                SELECT * FROM likes
                WHERE from_user = $1 AND to_user = $2 AND is_like = TRUE
            `, [to_user, from_user]);

            if (mutual.rows.length > 0) {
                isMatch = true;

                // Получаем данные того, с кем мэтч
                const userData = await pool.query(
                    "SELECT telegram_id, name, age, photo, bio FROM users WHERE telegram_id = $1",
                    [to_user]
                );
                matchedUser = userData.rows[0];
                console.log(`МЭТЧ! ${from_user} <-> ${to_user}`);
            }
        }

        res.json({ ok: true, isMatch, matchedUser });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
});

// Получить мои мэтчи
app.get("/api/matches", async (req, res) => {
    try {
        const { telegram_id } = req.query;

        if (!telegram_id) return res.status(400).json({ error: "telegram_id обязателен" });

        const result = await pool.query(`
            SELECT 
                u.telegram_id, u.name, u.age, u.photo, u.bio, u.gender
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

app.listen(port, () => {
    console.log(`Сервер запущен на порту ${port}`);
});
