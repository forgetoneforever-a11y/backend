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

// Создать таблицу при старте
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
    console.log("✅ База готова");
}
initDb().catch(console.error);

// Проверка
app.get("/", (req, res) => res.send("Ember API работает 🔥"));

// 📝 Регистрация — сохранить анкету
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

// 📋 Получить анкеты (кроме своей)
app.get("/api/recommendations", async (req, res) => {
    try {
        const { telegram_id, gender, looking_for, min_age, max_age } = req.query;

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

app.listen(port, () => {
    console.log(`🚀 Сервер запущен на порту ${port}`);
});
