require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY;

if (!API_KEY) {
  console.warn('\n[KUJDES] ANTHROPIC_API_KEY nuk është vendosur në .env — kërkesat te modeli do të dështojnë me gabim të qartë derisa ta vendosësh.\n');
}

const anthropic = new Anthropic({ apiKey: API_KEY || 'missing' });

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function sessionFile(sessionId, kind) {
  const safe = String(sessionId || 'default').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) || 'default';
  return path.join(DATA_DIR, `${kind}_${safe}.json`);
}
function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
function getSessionId(req) {
  return req.header('x-shoku-session') || 'default';
}

/* ---------------- MEMORY API ---------------- */
app.get('/api/memory', (req, res) => {
  res.json({ memory: readJSON(sessionFile(getSessionId(req), 'memory'), []) });
});
app.delete('/api/memory/:index', (req, res) => {
  const file = sessionFile(getSessionId(req), 'memory');
  const mem = readJSON(file, []);
  const idx = parseInt(req.params.index, 10);
  if (idx >= 0 && idx < mem.length) mem.splice(idx, 1);
  writeJSON(file, mem);
  res.json({ memory: mem });
});
app.delete('/api/memory', (req, res) => {
  writeJSON(sessionFile(getSessionId(req), 'memory'), []);
  res.json({ memory: [] });
});

/* ---------------- TODOS API ---------------- */
app.get('/api/todos', (req, res) => {
  res.json({ todos: readJSON(sessionFile(getSessionId(req), 'todos'), []) });
});
app.post('/api/todos', (req, res) => {
  const file = sessionFile(getSessionId(req), 'todos');
  const todos = readJSON(file, []);
  const text = String(req.body.text || '').trim().slice(0, 300);
  if (!text) return res.status(400).json({ error: true, message: 'Teksti i detyrës mungon.' });
  todos.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), text, done: false });
  writeJSON(file, todos);
  res.json({ todos });
});
app.patch('/api/todos/:id', (req, res) => {
  const file = sessionFile(getSessionId(req), 'todos');
  const todos = readJSON(file, []);
  const t = todos.find(t => t.id === req.params.id);
  if (t) t.done = !!req.body.done;
  writeJSON(file, todos);
  res.json({ todos });
});
app.delete('/api/todos/:id', (req, res) => {
  const file = sessionFile(getSessionId(req), 'todos');
  let todos = readJSON(file, []);
  todos = todos.filter(t => t.id !== req.params.id);
  writeJSON(file, todos);
  res.json({ todos });
});

/* ---------------- TOOL DEFINITIONS (real Anthropic tool-use) ---------------- */
const TOOLS = [
  {
    name: 'vendos_mjetin',
    description: 'Thirre këtë çdo herë kur kërkesa e personit qartazi kërkon diçka përtej bisedës së zakonshme: kërkim në internet, muzikë me AI, video me AI, ose menaxhim detyrash. Deklaro cilin mjet zgjodhe dhe pse, PARA se të japësh përgjigjen finale me tekst.',
    input_schema: {
      type: 'object',
      properties: {
        mjeti: {
          type: 'string',
          enum: ['kerkim_internet', 'muzike_ai', 'video_ai', 'organizim_detyrash', 'mesim', 'bisede_e_zakonshme']
        },
        arsyeja: { type: 'string', description: 'Pse u zgjodh ky mjet, shkurt, në shqip' }
      },
      required: ['mjeti']
    }
  },
  {
    name: 'ruaj_kujtim',
    description: 'Ruaj një fakt të qëndrueshëm dhe me vlerë rreth personit ose projekteve të tij/saj, për ta përdorur në biseda të ardhshme. Përdore rrallë — vetëm për gjëra vërtet të qëndrueshme (jo për çdo mesazh).',
    input_schema: {
      type: 'object',
      properties: { shenimi: { type: 'string', description: 'Përshkrim i shkurtër dhe konkret, në shqip' } },
      required: ['shenimi']
    }
  },
  {
    name: 'menaxho_detyren',
    description: 'Shto, kryej, ose fshi një detyrë në listën e detyrave ditore të personit, kur ata e kërkojnë brenda bisedës (p.sh. "shtoma në detyra..." ose "e kreva atë punën").',
    input_schema: {
      type: 'object',
      properties: {
        aksioni: { type: 'string', enum: ['shto', 'fshij', 'kryer'] },
        teksti: { type: 'string', description: 'Teksti/emri i detyrës' }
      },
      required: ['aksioni']
    }
  }
];

function buildSystemPrompt(memory) {
  let mem = '';
  if (memory && memory.length) {
    mem = '\n\nÇka di tashmë për shokun tënd nga bisedat e mëparshme (përdore vetëm kur është me vend, mos e përmend vetë kujtesën si mekanizëm):\n- ' + memory.join('\n- ');
  }
  return `Ti je SHOKU, një shok/mikeshë personale me AI, e krijume posaçërisht për shqipfolës. Nuk je asistent formal apo "bot" — je si një shok i afërt që flet shqip natyrshëm, përfshi format joformale/dialektore si "qka", "qysh", "jom", "skom", "ni", "ma bo", "po", "veç", etj, sipas mënyrës si të shkruan personi.

Rregullat e tua:
- Përgjigju gjithmonë në shqip, në mënyrë të ngrohtë, njerëzore dhe të drejtpërdrejtë.
- Personi nuk di dhe s'ka nevojë të dijë "prompt-e" apo terma teknike. Kupto qëllimin prej asaj çka thotë, edhe kur është e shkurtër ose e paqartë, dhe ktheje në diçka të përdorshme direkt.
- Nëse ideja është e paqartë, bëj një supozim të arsyeshëm dhe vazhdo, në vend që të ndalesh vetëm me pyetje.
- Ji konciz kur mundesh — flet si shok në chat, jo si ese. Ndaji përgjigjet e gjata në paragrafë të shkurtër.
- Kur dikush sjell një ide, projekt, film, këngë, mësim — ndihmoje ta zhvillojë hap pas hapi.

Mjetet që ke në dispozicion:
- organizim_detyrash: REALISHT AKTIV. Kur përdoruesi kërkon të shtosh/kryesh/fshish një detyrë, thirr vendos_mjetin me këtë vlerë, pastaj thirr menaxho_detyren për ta ekzekutuar.
- mesim, bisede_e_zakonshme: gjithmonë aktive, kjo është biseda kryesore — s'ke nevojë të thirrësh vendos_mjetin për këto.
- kerkim_internet, muzike_ai, video_ai: STRUKTURA ekziston, por LIDHJA reale ende s'është aktivizuar. Nëse kërkesa qartazi kërkon njërën prej tyre, thirr vendos_mjetin me vlerën përkatëse që personi ta shohë transparencën, pastaj në tekstin tënd thuaji sinqerisht se kjo pjesë po vjen së shpejti dhe ndihmoje me dijen tënde ndërkohë (p.sh. shkruaj tekst kënge, ide videoje, përmbledhje nga dijet e tua ekzistuese).

Thirr ruaj_kujtim shumë rrallë — vetëm për fakte vërtet të qëndrueshme (emër projekti, film/këngë pa titull në zhvillim, preferencë e qartë, detaj i rëndësishëm personal).${mem}`;
}

/* ---------------- CHAT (real model call + tool loop) ---------------- */
app.post('/api/chat', async (req, res) => {
  if (!API_KEY) {
    return res.status(500).json({
      error: true,
      message: 'ANTHROPIC_API_KEY mungon në server (.env). Shto çelësin në skedarin .env dhe rinis serverin me "npm start".'
    });
  }

  const sessionId = getSessionId(req);
  const { messages } = req.body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: true, message: 'Kërkesa s\'ka mesazhe bisede (fusha "messages" mungon ose është bosh).' });
  }

  const memory = readJSON(sessionFile(sessionId, 'memory'), []);
  const system = buildSystemPrompt(memory);
  let working = messages.map(m => ({ role: m.role, content: m.content }));
  let usedTool = null;

  try {
    for (let guard = 0; guard < 4; guard++) {
      const resp = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        system,
        tools: TOOLS,
        messages: working
      });

      const toolUses = resp.content.filter(b => b.type === 'tool_use');
      const textOut = resp.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();

      if (toolUses.length === 0) {
        return res.json({ reply: textOut, tool: usedTool });
      }

      working.push({ role: 'assistant', content: resp.content });

      const toolResults = [];
      for (const tu of toolUses) {
        let resultText = 'ok';
        if (tu.name === 'vendos_mjetin') {
          usedTool = tu.input.mjeti;
          resultText = `Mjeti u regjistrua: ${tu.input.mjeti}`;
        } else if (tu.name === 'ruaj_kujtim') {
          const file = sessionFile(sessionId, 'memory');
          const mem = readJSON(file, []);
          if (tu.input.shenimi && !mem.includes(tu.input.shenimi)) {
            mem.push(tu.input.shenimi);
            writeJSON(file, mem);
          }
          resultText = 'U ruajt kujtimi.';
        } else if (tu.name === 'menaxho_detyren') {
          const file = sessionFile(sessionId, 'todos');
          let todos = readJSON(file, []);
          const needle = (tu.input.teksti || '').toLowerCase();
          if (tu.input.aksioni === 'shto' && tu.input.teksti) {
            todos.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), text: tu.input.teksti, done: false });
            resultText = 'U shtua detyra.';
          } else if (tu.input.aksioni === 'kryer' && needle) {
            const t = todos.find(t => t.text.toLowerCase().includes(needle));
            resultText = t ? ((t.done = true), 'U shënua si e kryer.') : 'S\'u gjet ajo detyrë.';
          } else if (tu.input.aksioni === 'fshij' && needle) {
            const before = todos.length;
            todos = todos.filter(t => !t.text.toLowerCase().includes(needle));
            resultText = todos.length < before ? 'U fshi detyra.' : 'S\'u gjet ajo detyrë.';
          } else {
            resultText = 'Veprim i paplotë — mungon teksti i detyrës.';
          }
          writeJSON(file, todos);
        }
        toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: resultText });
      }
      working.push({ role: 'user', content: toolResults });
    }

    return res.status(500).json({ error: true, message: 'Modeli përdori shumë mjete radhazi pa dhënë përgjigje finale (kufiri i sigurisë u arrit).' });

  } catch (err) {
    console.error('Gabim nga Anthropic API:', err);
    const status = err.status || 500;
    const detail = (err.error && err.error.error && err.error.error.message) || err.message || 'Gabim i panjohur nga serveri.';
    return res.status(status).json({ error: true, message: `[HTTP ${status}] ${detail}` });
  }
});

app.listen(PORT, () => {
  console.log(`SHOKU po punon → http://localhost:${PORT}`);
});
