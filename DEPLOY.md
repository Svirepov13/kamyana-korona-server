# КАМ'ЯНА КОРОНА — Інструкція деплою

## Крок 1 — Supabase (база даних)

1. Іди на **supabase.com** → Sign Up (безкоштовно)
2. Create New Project → вкажи назву і пароль
3. Чекай ~2 хвилини поки створюється
4. Іди в **SQL Editor** (зліва)
5. Вставте весь вміст файлу **schema.sql** і натисни Run
6. Іди в **Settings → Database → Connection string → URI**
7. Скопіюй рядок типу: `postgresql://postgres:[PASSWORD]@db.xxx.supabase.co:5432/postgres`

## Крок 2 — GitHub (код)

1. Іди на **github.com** → New repository
2. Назви `kamyana-korona-server`
3. Завантаж всі файли з цієї папки:
   - `server.js`
   - `package.json`
   - `railway.json`
   - `.gitignore`
   - папку `public/` з `index.html`
   
   **НЕ завантажуй:** `.env` (він містить паролі!)

## Крок 3 — Railway (сервер)

1. Іди на **railway.app** → Login with GitHub
2. **New Project** → **Deploy from GitHub repo**
3. Вибери `kamyana-korona-server`
4. Натисни **Deploy**
5. Після деплою іди в **Variables** і додай:

```
DATABASE_URL = postgresql://postgres:[PASSWORD]@db.xxx.supabase.co:5432/postgres
JWT_SECRET   = будь-який-довгий-рядок-наприклад-моя-гра-2024-xyz
NODE_ENV     = production
```

6. Railway перезапустить сервер автоматично
7. Іди в **Settings → Domains** → Generate Domain
8. Отримаєш URL типу: `https://kamyana-korona-server-production.up.railway.app`

## Крок 4 — Готово!

Гра доступна за посиланням Railway!

Перевір що працює:
- ✅ Реєстрація нового гравця
- ✅ Логін
- ✅ Ресурси накопичуються
- ✅ Чат в реальному часі
- ✅ Список гравців
- ✅ Атака на гравців

## Структура файлів

```
kamyana-korona-server/
├── server.js          ← Node.js сервер
├── package.json       ← залежності
├── railway.json       ← налаштування Railway
├── schema.sql         ← структура БД (запустити в Supabase)
├── .gitignore         ← НЕ завантажує .env
├── .env.example       ← приклад змінних середовища
└── public/
    └── index.html     ← весь фронтенд
```

## Якщо щось не працює

- Перевір **Logs** в Railway — там видно помилки
- Переконайся що DATABASE_URL правильний
- Переконайся що схема SQL запущена в Supabase
