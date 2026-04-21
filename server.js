require('dotenv').config();
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const { Pool }   = require('pg');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const cors       = require('cors');
const path       = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

// ── DB ────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

const JWT_SECRET = process.env.JWT_SECRET || 'kamyana-korona-secret-2024';
const PORT       = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── ONLINE PLAYERS (in-memory) ────────────────
const onlinePlayers = new Map(); // socketId → {playerId, username}

// ── AUTH MIDDLEWARE ───────────────────────────
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Потрібна авторизація' });
  try {
    req.player = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Невалідний токен' });
  }
}

// ══════════════════════════════════════════════
// REST API — AUTH
// ══════════════════════════════════════════════

// РЕЄСТРАЦІЯ
app.post('/api/register', async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password)
    return res.status(400).json({ error: 'Заповніть всі поля' });
  if (username.length < 3 || username.length > 20)
    return res.status(400).json({ error: "Ім'я: 3-20 символів" });
  if (password.length < 6)
    return res.status(400).json({ error: 'Пароль мінімум 6 символів' });

  try {
    const hash = await bcrypt.hash(password, 10);
    // Random position on map
    const q = 5  + Math.floor(Math.random() * 38);
    const r = 5  + Math.floor(Math.random() * 24);

    const result = await pool.query(
      `INSERT INTO players (username, email, password, map_q, map_r)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, username`,
      [username.trim(), email.trim().toLowerCase(), hash, q, r]
    );
    const player = result.rows[0];

    // Init buildings, techs, army
    await pool.query('SELECT init_player($1)', [player.id]);

    const token = jwt.sign({ id: player.id, username: player.username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, username: player.username, id: player.id });

    // Notify all players about new player
    io.emit('player_joined', { username: player.username });
  } catch (e) {
    if (e.code === '23505') {
      const field = e.constraint?.includes('email') ? 'email' : 'імʼя';
      res.status(409).json({ error: `Такий ${field} вже існує` });
    } else {
      console.error('Register error:', e.message);
      res.status(500).json({ error: 'Помилка сервера' });
    }
  }
});

// ЛОГІН
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: 'Заповніть всі поля' });

  try {
    const result = await pool.query(
      'SELECT * FROM players WHERE username = $1', [username.trim()]
    );
    if (!result.rows.length)
      return res.status(401).json({ error: 'Гравець не знайдений' });

    const player = result.rows[0];
    const ok = await bcrypt.compare(password, player.password);
    if (!ok) return res.status(401).json({ error: 'Невірний пароль' });

    await pool.query('UPDATE players SET last_online = NOW() WHERE id = $1', [player.id]);

    const token = jwt.sign({ id: player.id, username: player.username }, JWT_SECRET, { expiresIn: '7d' });

    // Process offline gains
    const state = await loadPlayerState(player.id);
    res.json({ token, username: player.username, id: player.id, state });
  } catch (e) {
    console.error('Login error:', e.message);
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

// ══════════════════════════════════════════════
// REST API — GAME STATE
// ══════════════════════════════════════════════

// Завантажити стан гравця
app.get('/api/state', authMiddleware, async (req, res) => {
  try {
    const state = await loadPlayerState(req.player.id);
    res.json(state);
  } catch (e) {
    console.error('State error:', e.message);
    res.status(500).json({ error: 'Помилка сервера' });
  }
});

// Зберегти стан (ресурси)
app.post('/api/save', authMiddleware, async (req, res) => {
  const { food, wood, stone } = req.body;
  try {
    await pool.query(
      'UPDATE players SET food=$1, wood=$2, stone=$3, last_online=NOW() WHERE id=$4',
      [Math.floor(food||0), Math.floor(wood||0), Math.floor(stone||0), req.player.id]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Помилка збереження' });
  }
});

// Побудувати будівлю
app.post('/api/build', authMiddleware, async (req, res) => {
  const { type, cost } = req.body;
  const pid = req.player.id;
  try {
    // Check resources
    const pr = await pool.query('SELECT food, wood, stone FROM players WHERE id=$1', [pid]);
    const p = pr.rows[0];
    if (p.food < (cost.f||0) || p.wood < (cost.w||0) || p.stone < (cost.s||0))
      return res.status(400).json({ error: 'Недостатньо ресурсів' });

    // Deduct resources
    await pool.query(
      'UPDATE players SET food=food-$1, wood=wood-$2, stone=stone-$3 WHERE id=$4',
      [cost.f||0, cost.w||0, cost.s||0, pid]
    );

    // Set building busy
    const finishAt = Date.now() + (req.body.seconds * 1000);
    await pool.query(
      'UPDATE buildings SET busy=true, finish_at=$1 WHERE player_id=$2 AND type=$3',
      [finishAt, pid, type]
    );

    res.json({ ok: true, finishAt });
  } catch (e) {
    console.error('Build error:', e.message);
    res.status(500).json({ error: 'Помилка будівництва' });
  }
});

// Завершити будівництво (перевірка)
app.post('/api/build/complete', authMiddleware, async (req, res) => {
  const { type } = req.body;
  const pid = req.player.id;
  try {
    const br = await pool.query(
      'SELECT * FROM buildings WHERE player_id=$1 AND type=$2', [pid, type]
    );
    const b = br.rows[0];
    if (!b || !b.busy) return res.status(400).json({ error: 'Не будується' });
    if (Date.now() < b.finish_at) return res.status(400).json({ error: 'Ще не завершено' });

    await pool.query(
      'UPDATE buildings SET level=level+1, busy=false, finish_at=0 WHERE player_id=$1 AND type=$2',
      [pid, type]
    );
    const newLevel = b.level + 1;
    res.json({ ok: true, level: newLevel });
  } catch (e) {
    res.status(500).json({ error: 'Помилка' });
  }
});

// Дослідити технологію
app.post('/api/research', authMiddleware, async (req, res) => {
  const { type, cost, seconds } = req.body;
  const pid = req.player.id;
  try {
    const pr = await pool.query('SELECT food, wood, stone FROM players WHERE id=$1', [pid]);
    const p = pr.rows[0];
    if (p.food < (cost.f||0) || p.wood < (cost.w||0) || p.stone < (cost.s||0))
      return res.status(400).json({ error: 'Недостатньо ресурсів' });

    await pool.query(
      'UPDATE players SET food=food-$1, wood=wood-$2, stone=stone-$3 WHERE id=$4',
      [cost.f||0, cost.w||0, cost.s||0, pid]
    );
    const finishAt = Date.now() + seconds * 1000;
    await pool.query(
      'UPDATE techs SET busy=true, finish_at=$1 WHERE player_id=$2 AND type=$3',
      [finishAt, pid, type]
    );
    res.json({ ok: true, finishAt });
  } catch (e) {
    res.status(500).json({ error: 'Помилка дослідження' });
  }
});

// Навчити воїна
app.post('/api/train', authMiddleware, async (req, res) => {
  const { type, cost } = req.body;
  const pid = req.player.id;
  try {
    const pr = await pool.query('SELECT food, wood, stone FROM players WHERE id=$1', [pid]);
    const p = pr.rows[0];
    if (p.food < (cost.f||0) || p.wood < (cost.w||0) || p.stone < (cost.s||0))
      return res.status(400).json({ error: 'Недостатньо ресурсів' });

    await pool.query(
      'UPDATE players SET food=food-$1, wood=wood-$2, stone=stone-$3 WHERE id=$4',
      [cost.f||0, cost.w||0, cost.s||0, pid]
    );
    await pool.query(
      `UPDATE army SET ${type}=${type}+1 WHERE player_id=$1`, [pid]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Помилка тренування' });
  }
});

// ══════════════════════════════════════════════
// REST API — PLAYERS MAP (список гравців на карті)
// ══════════════════════════════════════════════
app.get('/api/players', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, username, map_q, map_r, epoch,
              EXTRACT(EPOCH FROM (NOW() - last_online)) < 300 AS online
       FROM players ORDER BY id`
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'Помилка' });
  }
});

// ══════════════════════════════════════════════
// REST API — ATTACK PLAYER
// ══════════════════════════════════════════════
app.post('/api/attack', authMiddleware, async (req, res) => {
  const { defenderId, sent } = req.body;
  const attackerId = req.player.id;
  if (attackerId === defenderId) return res.status(400).json({ error: 'Не можна атакувати себе' });

  try {
    // Get attacker army
    const ar = await pool.query('SELECT * FROM army WHERE player_id=$1', [attackerId]);
    const aa = ar.rows[0];

    // Get defender power (based on their army)
    const dr = await pool.query('SELECT * FROM army WHERE player_id=$1', [defenderId]);
    const da = dr.rows[0];
    const dpow = ((da?.hunters||0)*3 + (da?.spearmen||0)*8 + (da?.scouts||0)*2);

    // Check sent <= available
    const sentH = Math.min(sent.hunters||0, aa.hunters);
    const sentS = Math.min(sent.spearmen||0, aa.spearmen);
    const sentSc= Math.min(sent.scouts||0,  aa.scouts);
    const myPow = sentH*6 + sentS*10 + sentSc*3;

    // Battle
    const roll = 0.7 + Math.random() * 0.6;
    const myF  = Math.round(myPow * roll);
    const won  = myF >= dpow;
    const draw = Math.abs(myF - dpow) < dpow * 0.15 && dpow > 0;

    const lr = won ? (dpow / Math.max(myPow, 1)) * 0.4 : 0.65;
    const lossH  = Math.min(Math.round(sentH  * lr), sentH);
    const lossS  = Math.min(Math.round(sentS  * lr), sentS);
    const lossSc = Math.min(Math.round(sentSc * lr), sentSc);

    // Deduct sent units
    await pool.query(
      'UPDATE army SET hunters=hunters-$1, spearmen=spearmen-$2, scouts=scouts-$3 WHERE player_id=$4',
      [sentH, sentS, sentSc, attackerId]
    );
    // Return survivors
    await pool.query(
      'UPDATE army SET hunters=hunters+$1, spearmen=spearmen+$2, scouts=scouts+$3 WHERE player_id=$4',
      [sentH-lossH, sentS-lossS, sentSc-lossSc, attackerId]
    );

    // Steal resources if won
    let stolen = { f:0, w:0, s:0 };
    if (won && !draw) {
      const rr = await pool.query('SELECT food, wood, stone FROM players WHERE id=$1', [defenderId]);
      const def = rr.rows[0];
      stolen.f = Math.min(Math.floor(def.food  * 0.2), 100);
      stolen.w = Math.min(Math.floor(def.wood  * 0.2), 100);
      stolen.s = Math.min(Math.floor(def.stone * 0.2), 80);
      await pool.query(
        'UPDATE players SET food=food-$1, wood=wood-$2, stone=stone-$3 WHERE id=$4',
        [stolen.f, stolen.w, stolen.s, defenderId]
      );
      await pool.query(
        'UPDATE players SET food=food+$1, wood=wood+$2, stone=stone+$3 WHERE id=$4',
        [stolen.f, stolen.w, stolen.s, attackerId]
      );
    }

    // Also damage defender army if lost (they defended)
    if (!won) {
      const dloss = Math.floor((da?.hunters||0) * 0.15);
      await pool.query(
        'UPDATE army SET hunters=GREATEST(0,hunters-$1) WHERE player_id=$2', [dloss, defenderId]
      );
    }

    // Save to attacks log
    const attackerResult = await pool.query('SELECT username FROM players WHERE id=$1', [attackerId]);
    const defenderResult = await pool.query('SELECT username FROM players WHERE id=$1', [defenderId]);
    await pool.query(
      `INSERT INTO attacks (attacker_id, defender_id, result, attacker_loss, defender_loss, rewards)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [attackerId, defenderId, won?(draw?'draw':'win'):'loss',
       JSON.stringify({hunters:lossH,spearmen:lossS,scouts:lossSc}),
       JSON.stringify({}), JSON.stringify(stolen)]
    );

    const report = {
      won, draw,
      losses: { hunters:lossH, spearmen:lossS, scouts:lossSc },
      stolen,
      myPow, enemyPow: dpow, myFinal: myF,
      attackerName: attackerResult.rows[0]?.username,
      defenderName: defenderResult.rows[0]?.username,
    };

    // Notify defender via Socket.io
    io.to(`player_${defenderId}`).emit('under_attack', {
      from: attackerResult.rows[0]?.username,
      result: won ? 'loss' : 'win',
      stolen,
    });

    // Global announce for big victories
    if (won && !draw) {
      io.emit('battle_news', {
        msg: `⚔ ${report.attackerName} переміг ${report.defenderName} і захопив ресурси!`
      });
    }

    res.json(report);
  } catch (e) {
    console.error('Attack error:', e.message);
    res.status(500).json({ error: 'Помилка атаки' });
  }
});

// ══════════════════════════════════════════════
// REST API — CHAT
// ══════════════════════════════════════════════

// Отримати останні 50 повідомлень
app.get('/api/chat', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, username, text, type, created_at FROM messages ORDER BY created_at DESC LIMIT 50'
    );
    res.json(result.rows.reverse());
  } catch (e) {
    res.status(500).json({ error: 'Помилка чату' });
  }
});

// ══════════════════════════════════════════════
// SOCKET.IO — REAL TIME
// ══════════════════════════════════════════════
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Немає токена'));
  try {
    socket.player = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    next(new Error('Невалідний токен'));
  }
});

io.on('connection', (socket) => {
  const { id: playerId, username } = socket.player;
  console.log(`✅ Connected: ${username} (${socket.id})`);

  // Join player's personal room
  socket.join(`player_${playerId}`);
  onlinePlayers.set(socket.id, { playerId, username });

  // Broadcast online count
  io.emit('online_count', onlinePlayers.size);
  io.emit('player_online', { username, online: true });

  // ── CHAT MESSAGE ──────────────────────────
  socket.on('chat_message', async (data) => {
    const text = (data.text || '').trim().slice(0, 500);
    if (!text) return;
    try {
      const result = await pool.query(
        'INSERT INTO messages (player_id, username, text, type) VALUES ($1,$2,$3,$4) RETURNING *',
        [playerId, username, text, 'global']
      );
      const msg = result.rows[0];
      // Broadcast to everyone
      io.emit('chat_message', {
        id:         msg.id,
        username:   msg.username,
        text:       msg.text,
        created_at: msg.created_at,
      });
    } catch (e) {
      console.error('Chat error:', e.message);
    }
  });

  // ── REQUEST PLAYERS LIST ──────────────────
  socket.on('get_players', async () => {
    try {
      const result = await pool.query(
        `SELECT id, username, map_q, map_r, epoch,
                EXTRACT(EPOCH FROM (NOW() - last_online)) < 300 AS online
         FROM players ORDER BY id`
      );
      socket.emit('players_list', result.rows);
    } catch (e) {}
  });

  // ── PING (keepalive) ──────────────────────
  socket.on('ping_alive', async () => {
    await pool.query('UPDATE players SET last_online=NOW() WHERE id=$1', [playerId]);
  });

  // ── DISCONNECT ────────────────────────────
  socket.on('disconnect', () => {
    console.log(`❌ Disconnected: ${username}`);
    onlinePlayers.delete(socket.id);
    io.emit('online_count', onlinePlayers.size);
    io.emit('player_online', { username, online: false });
  });
});

// ══════════════════════════════════════════════
// HELPER — LOAD FULL PLAYER STATE
// ══════════════════════════════════════════════
async function loadPlayerState(playerId) {
  const [pr, br, tr, ar, or2] = await Promise.all([
    pool.query('SELECT * FROM players WHERE id=$1', [playerId]),
    pool.query('SELECT * FROM buildings WHERE player_id=$1', [playerId]),
    pool.query('SELECT * FROM techs WHERE player_id=$1', [playerId]),
    pool.query('SELECT * FROM army WHERE player_id=$1', [playerId]),
    pool.query('SELECT map_q, map_r, cell_type FROM owned_cells WHERE player_id=$1', [playerId]),
  ]);

  const p = pr.rows[0];
  const now = Date.now();

  // Process completed buildings/techs
  const bld = {};
  for (const b of br.rows) {
    if (b.busy && b.finish_at && now >= parseInt(b.finish_at)) {
      await pool.query(
        'UPDATE buildings SET level=level+1, busy=false, finish_at=0 WHERE id=$1', [b.id]
      );
      b.level += 1; b.busy = false; b.finish_at = 0;
    }
    bld[b.type] = { l: b.level, busy: b.busy, fa: parseInt(b.finish_at) || 0 };
  }

  const tech = {};
  for (const t of tr.rows) {
    if (t.busy && t.finish_at && now >= parseInt(t.finish_at)) {
      await pool.query(
        'UPDATE techs SET done=true, busy=false, finish_at=0 WHERE id=$1', [t.id]
      );
      t.done = true; t.busy = false; t.finish_at = 0;
    }
    tech[t.type] = { done: t.done, busy: t.busy, fa: parseInt(t.finish_at) || 0 };
  }

  const army = ar.rows[0] || { hunters: 0, spearmen: 0, scouts: 0 };
  const owned = {};
  for (const o of or2.rows) {
    owned[o.map_q + ',' + o.map_r] = { type: o.cell_type };
  }

  // Offline resource gains
  const offSec = Math.min((now - new Date(p.last_online).getTime()) / 1000, 43200);
  const farmLvl = bld.farm?.l || 0;
  const lumberLvl = bld.lumber?.l || 0;
  const quarryLvl = bld.quarry?.l || 0;
  const storehouseLvl = bld.storehouse?.l || 0;
  const agri = tech.agriculture?.done;
  const log  = tech.logging?.done;
  const mas  = tech.masonry?.done;

  const fr = Math.round((2 + farmLvl * 2)   * (agri ? 1.5 : 1));
  const wr = Math.round((2 + lumberLvl * 2) * (log  ? 1.5 : 1));
  const sr = Math.round((1 + quarryLvl)     * (mas  ? 1.5 : 1));
  const limit = 300 + storehouseLvl * 200;

  let food  = parseFloat(p.food) + fr * offSec / 60;
  let wood  = parseFloat(p.wood) + wr * offSec / 60;
  let stone = parseFloat(p.stone)+ sr * offSec / 60;
  food  = Math.min(limit, food);
  wood  = Math.min(limit, wood);
  stone = Math.min(limit, stone);

  if (offSec > 5) {
    await pool.query(
      'UPDATE players SET food=$1, wood=$2, stone=$3 WHERE id=$4',
      [Math.floor(food), Math.floor(wood), Math.floor(stone), playerId]
    );
  }

  return {
    id: p.id, username: p.username,
    food, wood, stone, pop: 5,
    map_q: p.map_q, map_r: p.map_r,
    epoch: p.epoch || 0,
    seed: p.id * 1337, // deterministic map seed per player
    bld, tech,
    army: { hunters: army.hunters, spearmen: army.spearmen, scouts: army.scouts },
    owned,
  };
}

// ── CATCH-ALL → serve index.html ─────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── START ─────────────────────────────────────
pool.connect()
  .then(() => {
    console.log('✅ Database connected');
    server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
  })
  .catch(e => {
    console.error('❌ Database connection failed:', e.message);
    process.exit(1);
  });
