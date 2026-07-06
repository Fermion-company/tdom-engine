-- daemon.lua — the in-TeX side of the checkpoint engine.
--
-- The engine process never restarts. Every block boundary is frozen as a
-- fork()ed process (copy-on-write snapshot of the COMPLETE TeX state:
-- catcodes, macros, fonts, counters, label table, everything). An edit kills
-- the stale suffix of the checkpoint chain and resumes typesetting from the
-- last valid snapshot — so the visible cost of a keystroke is one paragraph
-- of Knuth-Plass plus IPC.
--
-- THE EXACTNESS CONTRACT (v3.2): blocks are typeset on the REAL main
-- vertical list — no \vbox wrapper, no group. TeX's page builder is kept
-- dormant (\vsize=\maxdimen, a dummy box keeps the page "started" so nothing
-- is discarded, \holdinginserts=1 keeps footnotes in the stream) and after
-- each block the freshly contributed MVL nodes are harvested from
-- tex.lists.page_head. The harvested stream is BYTE-IDENTICAL to what a
-- vanilla run of lualatex builds for the whole document: inter-paragraph
-- glue, \parskip, \addvspace, club/widow penalties, \everypar effects and
-- \prevdepth all come from the same continuous TeX run — the orchestrator's
-- page builder never invents a single dimension.
--
-- Render children (exact-render tier) harvest the same nodes, vpack them
-- and \shipout a real PDF page, so the chunk pixels are the PDF's pixels.

local fk = nil
local sock = nil
local conn = nil
local PORT = 0
local WORKDIR = ''
local COUNTERS = {}
local CKPT = 0
local JOB = nil -- set in a freshly forked job child
local seen_fonts = {}
local blk_labels = {}
local blk_refs = {}
local blk_counters = {}
local blk_toclines = {}
local blk_events = {}
local blk_gfx = false
local blk_floats = {}
-- fonts referenced by the CURRENT job's harvested runs. Reported in full
-- with every galley: font ids are allocation-order artifacts of one fork
-- lineage (two lineages can give the same font different ids — or worse,
-- different fonts the same id), so the orchestrator must be able to
-- resolve every id from the galley payload alone, never from lineage
-- history. seen_fonts stays as the per-process meta cache.
local blk_fonts = {}
local pending_fmarks = {}
local geo_extra = {}
local RENDER_MODE = false
local FLOAT_COPIES = {}
local FOOT_COPIES = {}
-- Visual-fidelity flags for the CURRENT top-level line box being walked
-- (reset per box item in extract_items, accumulated through nested boxes):
--   line_x   the line needs an exact preview chunk (math nodes, math-font
--            or legacy CM glyphs — browser glyph output would differ)
--   line_xb  the line contains glyphs the browser cannot draw at all
--            (unencoded/PUA slots: OpenType math size variants, extensible
--            pieces) — not even a glyph bridge is presentable
local line_x = false
local line_xb = false

local SP2BP = 65781.76
-- 6 decimals: page assembly sums hundreds of these; 3 decimals accumulated
-- into ~0.1bp glue-set drift over a full page
local function bp(sp) return math.floor(((sp or 0) / SP2BP) * 1000000 + 0.5) / 1000000 end

local DUMMY_ATTR = 8123
local LASTSKIP_ATTR = 8124 -- marks the \lastskip primer glue (see tdom_prime_lastskip)

-- A block is harvested on a freshly-seeded page, so \lastskip is 0 when it
-- starts — but in a continuous run the previous block's trailing \addvspace
-- would still be on the list, and this block's leading \addvspace MAXes
-- against it (LaTeX \addvspace merges, never sums). Contribute a marked
-- primer glue of the previous block's trailing skip so \lastskip is correct;
-- extract_items drops the primer (it's already counted in the previous
-- block's galley). Without it, tcolorbox/list after-skip + a following
-- \section before-skip come out summed instead of maxed.
function tdom_prime_lastskip(sp)
  sp = tonumber(sp) or 0
  if sp == 0 then return end
  local g = node.new('glue')
  g.width = sp
  node.set_attribute(g, LASTSKIP_ATTR, 1)
  node.write(g)
end

-- ---------------------------------------------------------------- json

local function jstr(s)
  s = tostring(s)
  s = s:gsub('\\', '\\\\'):gsub('"', '\\"'):gsub('\n', '\\n'):gsub('\r', ''):gsub('\t', '\\t')
  s = s:gsub('[%z\1-\31]', '')
  return '"' .. s .. '"'
end

local function jenc(v)
  local t = type(v)
  if t == 'number' then
    if v ~= v or v == math.huge or v == -math.huge then return '0' end
    return string.format('%.10g', v)
  elseif t == 'boolean' then
    return tostring(v)
  elseif t == 'string' then
    return jstr(v)
  elseif t == 'table' then
    if v[1] ~= nil or next(v) == nil then
      local parts = {}
      for i = 1, #v do parts[#parts + 1] = jenc(v[i]) end
      return '[' .. table.concat(parts, ',') .. ']'
    else
      -- SORTED keys: pairs() order depends on the Lua hash seed, which
      -- differs per process — two lineages typesetting identical content
      -- would otherwise emit differently-ordered JSON, making every galley
      -- hash (and thus page identity) a per-lineage artifact. Deterministic
      -- bytes here are what make "same output ⇒ same hash" true end to end.
      local keys = {}
      for k in pairs(v) do keys[#keys + 1] = k end
      table.sort(keys, function(a, b) return tostring(a) < tostring(b) end)
      local parts = {}
      for _, k in ipairs(keys) do parts[#parts + 1] = jstr(k) .. ':' .. jenc(v[k]) end
      return '{' .. table.concat(parts, ',') .. '}'
    end
  end
  return 'null'
end

-- ---------------------------------------------------------------- boot

function tdom_boot(port, workdir, counters)
  PORT = port
  WORKDIR = workdir
  COUNTERS = counters
  local shim, lerr = package.loadlib(workdir .. '/tdomfork.so', 'luaopen_tdomfork')
  if not shim then
    texio.write_nl('tdom: FATAL cannot load fork shim: ' .. tostring(lerr))
    os.exit(1)
  end
  fk = shim()
  fk.ignore_sigchld()
  sock = require('socket')
  conn = assert(sock.connect('127.0.0.1', PORT))
  conn:setoption('tcp-nodelay', true)
  conn:send('HELLO ckpt 0 ' .. fk.getpid() .. '\n')
  texio.write_nl('tdom: daemon resident, checkpoint 0, pid ' .. fk.getpid())
end

function tdom_geo()
  local function dim(name)
    local ok, v = pcall(function() return tex.dimen[name] end)
    return ok and bp(v or 0) or 0
  end
  local geo = {
    paperwidth = dim('paperwidth'),
    paperheight = dim('paperheight'),
    textwidth = dim('textwidth'),
    textheight = dim('textheight'),
    oddsidemargin = dim('oddsidemargin'),
    topmargin = dim('topmargin'),
    headheight = dim('headheight'),
    headsep = dim('headsep'),
    footskip = dim('footskip'),
    maxdepth = bp(tex.maxdepth or 0),
    baselineskip = bp(tex.baselineskip.width or 0),
    lineskip = bp(tex.lineskip.width or 0),
    parskip = bp(tex.parskip.width or 0),
    parindent = bp(tex.parindent or 0),
    -- full interline specs: the page builder re-runs \box's append_to_vlist
    -- when it commits an inline float (tex.web §679)
    lineskiplimit = bp(tex.lineskiplimit or 0),
    baselineskipst = bp(tex.baselineskip.stretch or 0),
    baselineskipsto = tex.baselineskip.stretch_order or 0,
    baselineskipsh = bp(tex.baselineskip.shrink or 0),
    baselineskipsho = tex.baselineskip.shrink_order or 0,
    lineskipst = bp(tex.lineskip.stretch or 0),
    lineskipsto = tex.lineskip.stretch_order or 0,
    lineskipsh = bp(tex.lineskip.shrink or 0),
    lineskipsho = tex.lineskip.shrink_order or 0,
  }
  for k, v in pairs(geo_extra) do geo[k] = v end
  local payload = jenc(geo)
  conn:send('GEO ' .. #payload .. '\n')
  conn:send(payload)
end

-- Measure the unicode twin math font so the orchestrator can align legacy
-- cmex glyph ink exactly (TeX extents vs twin extents).
function tdom_twin_metrics(fid)
  local f = font.getfont(fid)
  if not f or not f.characters then return end
  local parts = {}
  for cp, ch in pairs(f.characters) do
    local h = bp(ch.height or 0)
    local d = bp(ch.depth or 0)
    if h ~= 0 or d ~= 0 then
      parts[#parts + 1] = '"' .. tostring(cp) .. '":[' .. h .. ',' .. d .. ']'
    end
  end
  local payload = '{' .. table.concat(parts, ',') .. '}'
  conn:send('TWIN ' .. #payload .. '\n')
  conn:send(payload)
end

local function reconnect(role, idx)
  -- a forked child must not speak on the inherited descriptor
  if conn then conn:close() end
  conn = assert(sock.connect('127.0.0.1', PORT))
  conn:setoption('tcp-nodelay', true)
  conn:send('HELLO ' .. role .. ' ' .. idx .. ' ' .. fk.getpid() .. '\n')
end

-- ---------------------------------------------------------------- shims

-- amsmath's \label@in@display hands \ltx@label the key WITH its braces
-- ({eq:x}) — strip one surrounding pair or the live \r@… name is wrong
local function unbrace(s)
  if s and s:sub(1, 1) == '{' and s:sub(-1) == '}' then return s:sub(2, -2) end
  return s
end

function tdom_label(key, value)
  key = unbrace(key)
  local entry = { k = key, v = value }
  -- Define the label LIVE in this process lineage: \label only writes to the
  -- aux (which a resident engine never re-reads), so \r@<key> must be set
  -- here for in-chain \ref resolution to track edits. Under hyperref the
  -- \r@… body carries FIVE groups ({label}{page}{name}{anchor}{ext}) and
  -- hyperref's \@setref/\hyperref parse exactly that — a two-group body
  -- makes them grab stray tokens and typeset garbage.
  pcall(function()
    local href = token.get_macro('@currentHref')
    local body
    if href ~= nil then
      entry.h = href
      body = '{' .. value .. '}{1}{}{' .. href .. '}{}'
    else
      body = '{' .. value .. '}{1}'
    end
    token.set_macro('r@' .. key, body, 'global')
  end)
  blk_labels[#blk_labels + 1] = entry
end

function tdom_ref(key)
  blk_refs[#blk_refs + 1] = key
end

-- cleveref: \cref resolves through r@<key>@cref (the second aux macro the
-- package writes next to every \newlabel). Capture its value at \label time
-- and define it LIVE, exactly like the plain form — the [1][1][]1 page field
-- is the placeholder cleveref's parser expects (pages are the orchestrator's).
function tdom_label_cref(key, value)
  key = unbrace(key)
  blk_labels[#blk_labels + 1] = { k = key .. '@cref', v = value }
  pcall(function()
    token.set_macro('r@' .. key .. '@cref', '{' .. value .. '}{[1][1][]1}', 'global')
  end)
end

-- \cref{a,b,...}: one dependency per key, under the @cref name it reads
function tdom_ref_cref(keys)
  for k in string.gmatch(keys or '', '[^,%s]+') do
    blk_refs[#blk_refs + 1] = k .. '@cref'
  end
end

-- Table-of-contents lines are TeX's own: the driver shims \addcontentsline
-- and reports the entry exactly as \protected@write would have expanded it
-- (real \thechapter.\thesection formatting, class-specific levels). The
-- orchestrator substitutes only the page number — the one value it owns.
-- \addcontentsline routes through \addtocontents in modern kernels — the
-- flag lets the @raw capture skip what the entry capture already recorded.
tdom_in_acl = false

function tdom_tocline(ext, level, text)
  if level == '@raw' and tdom_in_acl then return end
  blk_toclines[#blk_toclines + 1] = { e = ext, l = level, t = text }
  -- stream marker: a tocline's PAGE must come from where it sits in the
  -- node stream, not from its block (one block can span many pages)
  pcall(function()
    local m = node.new('whatsit', node.subtype('special'))
    m.data = 'tdom:tl:' .. (#blk_toclines - 1)
    node.write(m)
  end)
end

-- Page-style layer events (\pagestyle/\thispagestyle/\pagenumbering/marks):
-- captured per block AND marked in the node stream at the exact point they
-- occur, so the page builder knows which page each event lands on even when
-- one block spans several pages. The header/footer boxes themselves are
-- typeset by TeX (tdom_hf_*) — nothing is invented.
function tdom_event(kind, a, b)
  blk_events[#blk_events + 1] = { k = kind, a = a, b = b }
  local ok, err = pcall(function()
    local m = node.new('whatsit', node.subtype('special'))
    m.data = 'tdom:ev:' .. (#blk_events - 1)
    node.write(m)
  end)
  if os.getenv('TDOM_TRACE_EV') then
    texio.write_nl('term and log', 'TDOMEV ' .. kind .. ' idx=' .. (#blk_events - 1) ..
      ' mode=' .. tostring(tex.nest[tex.nest.ptr].mode) .. ' nestptr=' .. tostring(tex.nest.ptr) ..
      ' ok=' .. tostring(ok) .. ' err=' .. tostring(err))
  end
end



function tdom_counter(name, value)
  blk_counters[name] = tonumber(value) or 0
end

function tdom_cites(keys)
  for k in keys:gmatch('[^,%s]+') do
    blk_refs[#blk_refs + 1] = 'cite:' .. k
  end
end

function tdom_bib(key, value)
  blk_labels[#blk_labels + 1] = { k = 'cite:' .. key, v = value }
  pcall(function()
    token.set_macro('b@' .. key, value, 'global')
  end)
end

-- geometry extras collected before tdom_geo (dimens/counts from LaTeX)
function tdom_dim(name, sp)
  geo_extra[name] = bp(tonumber(sp) or 0)
end

function tdom_num(name, value)
  geo_extra[name] = tonumber(value) or 0
end

-- full glue parameters: natural, stretch, shrink + orders (driver sends the
-- components via \gluestretch etc. so nothing is approximated)
function tdom_glue(name, w, st, sh, sto, sho)
  geo_extra[name] = {
    w = bp(tonumber(w) or 0),
    st = bp(tonumber(st) or 0),
    sh = bp(tonumber(sh) or 0),
    sto = tonumber(sto) or 0,
    sho = tonumber(sho) or 0,
  }
end

-- The class's \footnoterule, measured for real: the driver typesets it into
-- box0 and we report its exact vertical recipe (kerns + rules). The page
-- builder replays these items verbatim — no hardcoded class knowledge.
function tdom_footrule(boxnum)
  local box = tex.box[boxnum]
  if not box then return end
  local items = extract_items_of(box.list, box)
  geo_extra['footruleitems'] = items
end

-- ------------------------------------------------------- galley walking

local GLYPH = node.id('glyph')
local HLIST = node.id('hlist')
local VLIST = node.id('vlist')
local RULE = node.id('rule')
local GLUE = node.id('glue')
local KERN = node.id('kern')
local PENALTY = node.id('penalty')
local DISC = node.id('disc')
local WHATSIT = node.id('whatsit')
local INS = node.id('ins')
local MARK = node.id('mark')
local MATH = node.id('math')

local LIT_SUB = node.subtype and node.subtype('pdf_literal')
local COL_SUB = node.subtype and node.subtype('pdf_colorstack')
local SPECIAL_SUB = node.subtype and node.subtype('special')

local function check_special(n)
  if SPECIAL_SUB and n.subtype == SPECIAL_SUB and n.data then
    local fn = n.data:match('^tdomfloat:(%d+)$')
    if fn then
      pending_fmarks[#pending_fmarks + 1] = tonumber(fn)
      return true
    end
  end
  return false
end

local function note_font(fid)
  if not fid or fid <= 0 then return end
  blk_fonts[fid] = true
  if not seen_fonts[fid] then
    local f = font.getfont(fid) or {}
    seen_fonts[fid] = {
      file = f.filename or '',
      name = f.name or f.fullname or ('font' .. fid),
      size = bp(f.size or 655360),
      encb = f.encodingbytes or 0,
      fmt = f.format or '',
      -- OpenType MATH fonts (unicode-math &c.): their glyphs ARE math even
      -- when individually cmap-clean — the fidelity gate keys off this
      mth = (f.mathparameters or f.MathConstants) and 1 or nil,
    }
  end
end

local function hex2(v)
  return string.format('%02x', math.max(0, math.min(255, math.floor(v + 0.5))))
end

local function parse_color(data)
  if not data then return nil end
  -- recognize the common color ops emitted by the LaTeX color stack
  local r, g, b = data:match('^([%d.]+)%s+([%d.]+)%s+([%d.]+)%s+rg')
  if r then return '#' .. hex2(r * 255) .. hex2(g * 255) .. hex2(b * 255) end
  local gr = data:match('^([%d.]+)%s+g')
  if gr then local v = hex2(gr * 255) return '#' .. v .. v .. v end
  local c, m, y, k = data:match('^([%d.]+)%s+([%d.]+)%s+([%d.]+)%s+([%d.]+)%s+k')
  if c then
    return '#' .. hex2(255 * (1 - math.min(1, c + k))) ..
      hex2(255 * (1 - math.min(1, m + k))) ..
      hex2(255 * (1 - math.min(1, y + k)))
  end
  return nil
end

-- Walker state: color stack shared across the whole galley walk.
local colstack = {}
local function curcolor()
  return colstack[#colstack] or '#000000'
end

-- Emit into `out` flat runs: {f=,s=,dy=,x=,c=,g='utf8 string'}
-- and rules {rule=true,x=,dy=,w=,h=}. dy is relative to the line baseline
-- (negative = raised). Runs are split at every kern/glue so the browser does
-- no shaping of its own: positions are TeX's.

local walk_h, walk_v

local function leader_rule(n)
  if node.getleader then
    return node.getleader(n)
  end
  return n.leader
end

local function emit_leader_rule(n, parent, x, dy0, out)
  local lead = leader_rule(n)
  if not lead or lead.id ~= RULE then return false end
  local w = node.effective_glue(n, parent) or n.width or 0
  if w <= 0 then return false end
  local h = lead.height or 0
  local d = lead.depth or 0
  if h < -1073741823 then h = 26214 end
  if d < -1073741823 then d = 0 end
  out[#out + 1] = { rule = true, x = x, dy = dy0 - bp(h), w = bp(w), h = bp(h) + bp(d), c = curcolor() }
  return true
end

walk_h = function(head, parent, x0, dy0, out)
  local x = x0
  local run = nil
  local function flush()
    if run and #run.g > 0 then out[#out + 1] = run end
    run = nil
  end
  local n = head
  while n do
    local id = n.id
    if id == GLYPH then
      note_font(n.font)
      local fi = seen_fonts[n.font]
      local gy = dy0 - bp(n.yoffset or 0)
      local gx = x + bp(n.xoffset or 0)
      if not run or run.f ~= n.font or run.dy ~= gy or run.c ~= curcolor() then
        flush()
        run = { f = n.font, s = fi and fi.size or 10, dy = gy, x = gx, c = curcolor(), g = {}, gh = 0, gd = 0 }
      end
      -- slots below 32 (legacy greek etc.) travel as PUA so JSON stays clean
      local c = n.char or 63
      local legacy = fi and fi.name and fi.name:find('^cm%l*%d')
      -- Legacy Computer Modern (Type1) glyphs — i.e. classic math setups —
      -- cannot be reproduced exactly in the browser (no Type1 @font-face,
      -- twins differ subtly), and OpenType MATH font glyphs go through
      -- TeX's math machinery (variants, extensibles, italic correction).
      -- Either way the LINE needs an exact preview chunk; the twin/glyph
      -- approximation is at best a brief bridge until it lands.
      if legacy or (fi and fi.mth) then
        line_x = true
      end
      -- Glyphs outside cmap reach: luaotfload parks unencoded glyphs
      -- (math size variants, extensible pieces) in the PUA planes, and
      -- anything ≥ 0x110000 is not even valid UTF-8 for the payload.
      -- The browser has no way to address these — no glyph bridge.
      if c >= 0x110000 then
        c = 63
        line_x = true
        line_xb = true
      elseif (c >= 0xE000 and c <= 0xF8FF and not legacy) or c >= 0xF0000 then
        line_x = true
        line_xb = true
      end
      if c < 32 then c = 0xE000 + c end
      run.g[#run.g + 1] = { c, gx }
      -- actual glyph extents from TeX's font tables (needed for the OMX
      -- vertical correction when substituting unicode twins client-side)
      local fdata = font.getfont(n.font)
      local cinfo = fdata and fdata.characters and fdata.characters[n.char]
      if cinfo then
        if bp(cinfo.height or 0) > run.gh then run.gh = bp(cinfo.height or 0) end
        if bp(cinfo.depth or 0) > run.gd then run.gd = bp(cinfo.depth or 0) end
      end
      x = x + bp(n.width or 0)
    elseif id == KERN then
      flush()
      x = x + bp(n.kern or 0)
    elseif id == GLUE then
      flush()
      emit_leader_rule(n, parent, x, dy0, out)
      x = x + bp(node.effective_glue(n, parent) or 0)
    elseif id == HLIST then
      flush()
      walk_h(n.list, n, x, dy0 + bp(n.shift or 0), out)
      x = x + bp(n.width or 0)
    elseif id == VLIST then
      flush()
      walk_v(n, x, dy0 + bp(n.shift or 0), out)
      x = x + bp(n.width or 0)
    elseif id == RULE then
      flush()
      local w = n.width
      local h = n.height
      local d = n.depth
      if w and w < -1073741823 then w = parent and parent.width or 0 end
      if h and h < -1073741823 then h = parent and parent.height or 0 end
      if d and d < -1073741823 then d = parent and parent.depth or 0 end
      out[#out + 1] = { rule = true, x = x, dy = dy0 - bp(h), w = bp(w), h = bp(h) + bp(d), c = curcolor() }
      x = x + bp(w or 0)
    elseif id == MATH then
      -- inline math on/off marker: the surrounding line must be shown as
      -- an exact preview chunk (fidelity gate) — math never rides the
      -- browser glyph path by default
      flush()
      line_x = true
      -- \mathsurround travels on the math node (kern-like, or glue in
      -- LuaTeX's mathsurroundskip form); zero in almost every document
      local mw = 0
      pcall(function() mw = node.effective_glue(n, parent) or 0 end)
      if mw == 0 then mw = n.surround or 0 end
      x = x + bp(mw)
    elseif id == DISC then
      -- post-linebreak: the replace text is what shows mid-line
      flush()
      if n.replace then
        local fake = node.hpack(node.copy_list(n.replace))
        walk_h(fake.list, fake, x, dy0, out)
        x = x + bp(fake.width or 0)
        node.free(fake)
      end
    elseif id == WHATSIT then
      if COL_SUB and n.subtype == COL_SUB then
        flush()
        local cmd = n.command or n.cmd
        local col = n.data and parse_color(n.data)
        if cmd == 1 then
          colstack[#colstack + 1] = col or curcolor()
        elseif cmd == 2 then
          colstack[#colstack] = nil
        elseif col then
          colstack[#colstack] = col
        end
      elseif LIT_SUB and n.subtype == LIT_SUB then
        blk_gfx = true
      else
        check_special(n)
      end
    end
    n = n.next
  end
  flush()
end

walk_v = function(box, x0, baseline_dy, out)
  -- box is a vlist whose baseline sits at baseline_dy; contents start at its top
  local y = baseline_dy - bp(box.height or 0)
  local n = box.list
  while n do
    local id = n.id
    if id == HLIST then
      local base = y + bp(n.height or 0)
      walk_h(n.list, n, x0 + bp(n.shift or 0), base, out)
      y = y + bp(n.height or 0) + bp(n.depth or 0)
    elseif id == VLIST then
      walk_v(n, x0 + bp(n.shift or 0), y + bp(n.height or 0), out)
      y = y + bp(n.height or 0) + bp(n.depth or 0)
    elseif id == RULE then
      local h = n.height
      local d = n.depth
      local w = n.width
      if h and h < -1073741823 then h = 26214 end
      if d and d < -1073741823 then d = 0 end
      if w and w < -1073741823 then w = box.width end
      out[#out + 1] = { rule = true, x = x0, dy = y, w = bp(w), h = bp(h) + bp(d), c = curcolor() }
      y = y + bp(h) + bp(d)
    elseif id == GLUE then
      y = y + bp(node.effective_glue(n, box) or 0)
    elseif id == KERN then
      y = y + bp(n.kern or 0)
    elseif id == WHATSIT then
      if LIT_SUB and n.subtype == LIT_SUB then blk_gfx = true end
    end
    n = n.next
  end
end

TDOM_FLOATBOX = 253 -- overwritten after \newbox\TDOMfloatbox

local function is_dummy(n)
  return n and n.id == HLIST and node.has_attribute(n, DUMMY_ATTR) ~= nil
end

local function new_dummy()
  local d = node.new('hlist')
  d.width = 0
  d.height = 0
  d.depth = 0
  node.set_attribute(d, DUMMY_ATTR, 1)
  return d
end

-- Walk a vertical node list into items. Glue carries its FULL specification
-- (natural/stretch/shrink + orders, subtype) because the orchestrator's page
-- builder runs TeX's own break-cost arithmetic over these values.
-- `parentBox` is nil for the top-level MVL harvest (glue there is unset, so
-- natural width IS the effective width).
local function extract_items(head, parentBox)
  local items = {}
  local n = head
  while n do
    local id = n.id
    if is_dummy(n) then
      -- the page-keeper box: not document content
    elseif not parentBox and node.has_attribute(n, LASTSKIP_ATTR) then
      -- the \lastskip primer: only present to make this block's leading
      -- \addvspace merge; its height belongs to the PREVIOUS block's galley
    elseif id == HLIST or id == VLIST or id == RULE then
      local h = n.height or 0
      local d = n.depth or 0
      local w = n.width or 0
      if id == RULE then
        if w < -1073741823 then w = (parentBox and parentBox.width) or tex.dimen.textwidth or 0 end
        if h < -1073741823 then h = 26214 end
        if d < -1073741823 then d = 0 end
      end
      local runs = {}
      -- visual-fidelity flags accumulate across the whole (possibly nested)
      -- walk of this one top-level line box
      line_x = false
      line_xb = false
      if id == HLIST then
        walk_h(n.list, n, 0, 0, runs)
      elseif id == VLIST then
        walk_v(n, 0, bp(h), runs)
      else
        runs[1] = { rule = true, x = 0, dy = -bp(h), w = bp(w), h = bp(h) + bp(d), c = '#000000' }
      end
      local item = { k = 'box', h = bp(h), d = bp(d), w = bp(w), runs = runs }
      if line_x then item.x = 1 end
      if line_xb then item.xb = 1 end
      if #pending_fmarks > 0 then
        item.fm = pending_fmarks
        pending_fmarks = {}
      end
      items[#items + 1] = item
    elseif id == GLUE then
      if not parentBox and (n.subtype or 0) == 10 then
        -- \topskip glue is page-builder machinery, not document content:
        -- the orchestrator's page builder inserts its own \topskip at real
        -- page tops. (It can appear here when TeX's dormant builder saw an
        -- "empty" page, e.g. right after boot or an absorbed output.)
      else
        local eff
        if parentBox then
          eff = bp(node.effective_glue(n, parentBox) or n.width)
        else
          eff = bp(n.width or 0)
        end
        local it = { k = 'glue', a = eff, sub = n.subtype or 0 }
        -- stretch/shrink only matter for the top-level stream (page
        -- breaking); inside packed boxes the set values are already final
        if not parentBox then
          if (n.stretch or 0) ~= 0 then
            it.st = bp(n.stretch)
            it.sto = n.stretch_order or 0
          end
          if (n.shrink or 0) ~= 0 then
            it.sh = bp(n.shrink)
            it.sho = n.shrink_order or 0
          end
        end
        items[#items + 1] = it
      end
    elseif id == KERN then
      items[#items + 1] = { k = 'kern', a = bp(n.kern or 0) }
    elseif id == PENALTY then
      items[#items + 1] = { k = 'pen', v = n.penalty or 0 }
    elseif id == INS then
      -- a footnote (or other insert): capture its typeset content.
      -- n.height is what TeX subtracts from the page goal.
      local content = n.head or n.list
      local sub = extract_items(content, n)
      local total = 0
      for _, it in ipairs(sub) do
        if it.k == 'box' then total = total + it.h + it.d
        elseif it.k == 'glue' or it.k == 'kern' then total = total + (it.a or 0) end
      end
      items[#items + 1] = {
        k = 'ins',
        class = n.subtype or 0,
        items = sub,
        h = bp(n.height or 0),
        d = bp(n.depth or 0),
        hc = total,
      }
    elseif id == WHATSIT then
      if check_special(n) then
        -- a vertical-mode float anchor: record it as a stream item at its
        -- exact position (LaTeX considers the float exactly here)
        for _, fn in ipairs(pending_fmarks) do
          items[#items + 1] = { k = 'fm', n = fn }
        end
        pending_fmarks = {}
      elseif SPECIAL_SUB and n.subtype == SPECIAL_SUB and n.data and n.data:match('^tdom:eject') then
        local pen = tonumber(n.data:match('^tdom:eject:(-?%d+)')) or -10000
        items[#items + 1] = { k = 'eject', v = pen }
      elseif SPECIAL_SUB and n.subtype == SPECIAL_SUB and n.data and n.data:match('^tdom:ev:') then
        -- page-style event marker: travels in the stream so the page
        -- builder knows EXACTLY which page the event lands on (a single
        -- block can span pages with \pagenumbering changes in between)
        local ei = tonumber(n.data:match('^tdom:ev:(%d+)')) or 0
        items[#items + 1] = { k = 'ev', n = ei }
      elseif SPECIAL_SUB and n.subtype == SPECIAL_SUB and n.data and n.data:match('^tdom:tl:') then
        -- tocline marker: same stream-anchoring for contents entries
        local ti = tonumber(n.data:match('^tdom:tl:(%d+)')) or 0
        items[#items + 1] = { k = 'tl', n = ti }
      elseif LIT_SUB and n.subtype == LIT_SUB then
        blk_gfx = true
      end
    end
    n = n.next
  end
  return items
end

-- referenced before definition inside tdom_footrule
function extract_items_of(head, parentBox)
  return extract_items(head, parentBox)
end

-- --------------------------------------------------- MVL harvest core

-- Reseed the dormant page with a fresh dummy box. The dummy keeps the page
-- non-empty so the page builder never discards leading glue (TeX drops
-- discardables on an empty page) and never inserts \topskip glue — both are
-- the orchestrator's job at real page boundaries.
--
-- IMPORTANT: the builder's internal page_contents FLAG is not reachable
-- from Lua; the driver first contributes a real \hbox to0pt{} (which sets
-- the flag to box_there) and only then calls tdom_seed to swap the list.
-- The flag survives all later list surgery.
-- Reseed THROUGH the real page builder: empty the page, hand a fresh dummy
-- to the CONTRIBUTION list and let build_page move it — TeX then resets its
-- internal page_so_far state (\pagegoal, \pagetotal, \pagedepth) itself.
-- Assigning tex.pagetotal directly does NOT stick: the dormant \pagetotal
-- kept accumulating across blocks and, at \maxdimen (~16384pt ≈ 25 pages of
-- content), the output routine started firing on every contribution — every
-- block past that point died in-chain and fell back to the isolated rescue,
-- which is exactly the "long documents crawl" wall.
local function reseed_page()
  local d = new_dummy()
  local oldc = tex.lists.contrib_head
  d.next = oldc
  if oldc then oldc.prev = d end
  tex.lists.page_head = nil
  tex.lists.contrib_head = d
  pcall(function() tex.triggerbuildpage() end)
  -- the builder inserts \topskip glue above the first box of a fresh page;
  -- the dummy is machinery, not content — unlink the glue or every block's
  -- harvest would begin with a phantom 10pt
  local h = tex.lists.page_head
  if h and h.id == GLUE and h.next and is_dummy(h.next) then
    tex.lists.page_head = h.next
    h.next.prev = nil
    h.next = nil
    node.free(h)
  end
  -- Zero the WHOLE page_so_far family. The dormant page never goes through
  -- fire_up, so the stretch/shrink accumulators grow monotonically across
  -- every block in the lineage; past ~25 pages of cumulative content the
  -- typesetting child starts spinning forever (every in-chain job times
  -- out and the whole document degrades to the rescue path).
  pcall(function()
    tex.pagetotal = 0
    tex.pagestretch = 0
    tex.pagefilstretch = 0
    tex.pagefillstretch = 0
    tex.pagefilllstretch = 0
    tex.pageshrink = 0
    tex.pagedepth = 0
  end)
end

function tdom_seed()
  pcall(function() tex.triggerbuildpage() end)
  local old = tex.lists.page_head
  local oldc = tex.lists.contrib_head
  tex.lists.contrib_head = nil
  tex.lists.page_head = nil
  if old then node.flush_list(old) end
  if oldc then node.flush_list(oldc) end
  reseed_page()
  -- fresh document start: no interline glue above the first line
  tex.nest[0].prevdepth = -65536000
end

-- Collect the freshly typeset MVL nodes (page list + any contributions the
-- page builder has not moved yet), as one continuous node list COPY-FREE.
local function harvest_nodes()
  pcall(function() tex.triggerbuildpage() end)
  local head = tex.lists.page_head
  local contrib = tex.lists.contrib_head
  -- detach both lists from TeX first, then reseed through the builder
  tex.lists.page_head = nil
  tex.lists.contrib_head = nil
  reseed_page()
  if head and contrib then
    local tail = node.tail(head)
    tail.next = contrib
    contrib.prev = tail
  end
  return head or contrib
end

-- Safety net: if something in the document force-ejects a page (\pagebreak,
-- \clearpage internals, a package's raw \penalty-10000), the output routine
-- fires. We absorb \box255 back into the dormant page, plant an eject marker
-- so the orchestrator breaks the page at exactly this point, and continue.
-- Resetting deadcycles below disables TeX's own output-loop protection, so
-- the absorb routine carries its own: a sane block fires the output routine
-- at most a handful of times (\clearpage = 2). A block that keeps firing is
-- caught in a page-builder cycle the dormant-page model cannot represent —
-- exit the fork child cleanly; the orchestrator rescues the block through
-- the isolated exact-render path instead of spinning forever.
local absorb_fires = 0
function tdom_absorb_reset()
  absorb_fires = 0
end

function tdom_absorb_output()
  absorb_fires = absorb_fires + 1
  if absorb_fires > 50 then
    texio.write_nl('term and log', 'tdom: output routine fired ' .. absorb_fires ..
      ' times in one block — page-builder cycle, bailing out of this fork')
    fk._exit(3)
  end
  tex.deadcycles = 0
  local pen = tex.outputpenalty or -10000
  if os.getenv('TDOM_TRACE_OUTPUT') then
    local jid = JOB and JOB.id or '?'
    local desc = {}
    local dlen = 0
    local n = tex.box[255] and tex.box[255].list or nil
    while n and dlen < 10 do
      dlen = dlen + 1
      local t = node.type(n.id)
      if t == 'penalty' then t = t .. '(' .. (n.penalty or 0) .. ')' end
      desc[dlen] = t
      n = n.next
    end
    texio.write_nl('term and log', 'TDOMTRACE absorb job=' .. jid .. ' pen=' .. pen ..
      ' box255=[' .. table.concat(desc, ' ') .. (n and ' ...' or '') .. ']')
  end
  local b = tex.box[255]
  local list = nil
  if b then
    list = b.list
    b.list = nil
    tex.box[255] = nil -- frees the (now empty) box node
  end
  local marker = nil
  if pen > -10002 then
    -- a genuine eject (\newpage -10000 / \clearpage -10001), not a float
    -- signal: plant the marker at the break position
    marker = node.new('whatsit', SPECIAL_SUB)
    marker.data = 'tdom:eject:' .. pen
  end
  local newhead = list
  if not newhead or not is_dummy(newhead) then
    local d = new_dummy()
    d.next = newhead
    if newhead then newhead.prev = d end
    newhead = d
  end
  if marker then
    local tail = node.tail(newhead)
    tail.next = marker
    marker.prev = tail
  end
  -- The output routine left the page truly empty (its internal
  -- page_contents flag included). Hand the material back through the
  -- CONTRIBUTION list so the first box (our dummy) restores the flag; the
  -- \topskip glue the builder puts above the dummy is dropped at harvest.
  local oldc = tex.lists.contrib_head
  if oldc then
    local tail = node.tail(newhead)
    tail.next = oldc
    oldc.prev = tail
  end
  tex.lists.contrib_head = newhead
  pcall(function() tex.pagetotal = 0 end)
end

-- Called from the float environment shims: capture the float box galley.
function tdom_float(n, placement, ftype)
  local box = tex.box[TDOM_FLOATBOX]
  if not box then return end
  colstack = {}
  local saved_gfx = blk_gfx
  blk_gfx = false
  local saved_marks = pending_fmarks
  pending_fmarks = {}
  local items = extract_items(box.list, box)
  pending_fmarks = saved_marks
  local fgfx = blk_gfx
  blk_gfx = saved_gfx
  blk_floats[#blk_floats + 1] = {
    n = n,
    placement = placement or 'tbp',
    type = ftype or 'figure',
    w = bp(box.width or 0),
    h = bp(box.height or 0),
    d = bp(box.depth or 0),
    gfx = fgfx,
    items = items,
  }
  if RENDER_MODE then
    FLOAT_COPIES[#FLOAT_COPIES + 1] = node.copy_list(box)
  end
end

-- ---------------------------------------------------------- reporting

local function encode_runs(items)
  -- Runs are split at every kern/glue during the walk, so within a run the
  -- browser reproduces TeX's positions from pure font advances; only the
  -- run-start x needs to travel. Recurses into footnote inserts.
  for _, it in ipairs(items) do
    if it.runs then
      for _, r in ipairs(it.runs) do
        if r.g then
          local chars = {}
          for i, pair in ipairs(r.g) do
            chars[i] = unicode.utf8.char(pair[1] > 0 and pair[1] or 63)
          end
          r.t = table.concat(chars)
          r.g = nil
        end
      end
    end
    if it.items then encode_runs(it.items) end
  end
end

-- Header/footer harvest for the page-style job: the orchestrator sets the
-- page's exact state (folio, \thepage format, style, marks), typesets the
-- head/foot boxes, and we extract their glyph runs like any other galley.
local hf_pages = {}
function tdom_hf_box(boxnum, page, which)
  local box = tex.box[boxnum]
  if not box then return end
  colstack = {}
  local saved_marks = pending_fmarks
  pending_fmarks = {}
  local items = extract_items(box.list, box)
  pending_fmarks = saved_marks
  -- string key: consecutive integer keys would json-encode as an array
  local key = 'p' .. page
  hf_pages[key] = hf_pages[key] or {}
  hf_pages[key][which] = items
end

function tdom_hf_flush()
  for _, page in pairs(hf_pages) do
    if page.h then encode_runs(page.h) end
    if page.f then encode_runs(page.f) end
  end
  local fonts = {}
  for fid in pairs(blk_fonts) do
    local f = seen_fonts[fid]
    if f then
      fonts[tostring(fid)] = { file = f.file, name = f.name, size = f.size, fmt = f.fmt, mth = f.mth }
    end
  end
  local payload = jenc({ block = '__hf', hf = hf_pages, fonts = fonts })
  conn:send('GALLEY __hf ' .. #payload .. '\n')
  conn:send(payload)
  fk._exit(0)
end

function tdom_report()
  if os.getenv('TDOM_TRACE_MEM') then
    local ok, st = pcall(status.list)
    st = ok and st or {}
    local t0 = os.clock()
    for _ = 1, 5000 do
      local g = node.new('glue')
      node.free(g)
    end
    local tg = (os.clock() - t0) * 1000
    t0 = os.clock()
    for _ = 1, 2000 do
      local h = node.new('hlist')
      node.free(h)
    end
    local th = (os.clock() - t0) * 1000
    texio.write_nl('term and log', string.format(
      'TDOMMEM job=%s tot=%s str=%s fil=%s fill=%s shr=%s dep=%s',
      tostring(JOB and JOB.id or '?'),
      tostring(tex.pagetotal), tostring(tex.pagestretch), tostring(tex.pagefilstretch),
      tostring(tex.pagefillstretch), tostring(tex.pageshrink), tostring(tex.pagedepth)))
  end
  -- cross-block layout state: the next block's leading interline glue and
  -- \@afterheading behavior depend on these — they join the state vector so
  -- the orchestrator's convergence check re-typesets downstream blocks
  -- whenever they move (same mechanism as counters).
  blk_counters['tdom@pd'] = math.floor(tex.nest[0].prevdepth or 0)
  -- trailing vertical skip (for the NEXT block's \addvspace merge): the last
  -- glue on the list before harvest, in sp. Non-glue tail = no mergeable skip.
  do
    pcall(function() tex.triggerbuildpage() end)
    local list = tex.lists.contrib_head or tex.lists.page_head
    local t = list and node.tail(list)
    local ls = 0
    while t do
      if is_dummy(t) then
        -- keeper box: keep scanning past it
      elseif t.id == GLUE then ls = t.width break
      else break end
      t = t.prev
    end
    blk_counters['tdom@ls'] = math.floor(ls)
  end
  local head = harvest_nodes()
  colstack = {}
  pending_fmarks = {}
  local items = extract_items(head, nil)
  local w, hsum = 0, 0
  for _, it in ipairs(items) do
    if it.k == 'box' then
      if (it.w or 0) > w then w = it.w end
      hsum = hsum + it.h + it.d
    elseif it.k == 'glue' or it.k == 'kern' then
      hsum = hsum + (it.a or 0)
    end
  end
  encode_runs(items)
  for _, f in ipairs(blk_floats) do encode_runs(f.items) end
  -- complete font table for THIS galley: every id its runs reference
  local fonts = {}
  for fid in pairs(blk_fonts) do
    local f = seen_fonts[fid]
    if f then
      fonts[tostring(fid)] = { file = f.file, name = f.name, size = f.size, fmt = f.fmt, mth = f.mth }
    end
  end
  local payload = jenc({
    block = JOB.id,
    gfx = blk_gfx,
    w = w,
    h = hsum,
    d = 0,
    items = items,
    floats = blk_floats,
    fonts = fonts,
    labels = blk_labels,
    refs = blk_refs,
    state = blk_counters,
    toclines = blk_toclines,
    events = blk_events,
  })
  if head then node.flush_list(head) end
  conn:send('GALLEY ' .. JOB.id .. ' ' .. #payload .. '\n')
  conn:send(payload)
  -- Collect BEFORE this process becomes a long-lived checkpoint: the fork
  -- chain inherits the whole Lua heap, so uncollected per-job garbage
  -- (luatexja's per-paragraph tables, payload strings) compounds across
  -- generations — on Japanese documents the per-block cost was measured
  -- growing from ~1ms to ~11s along a 450-block chain without this.
  -- Thresholded so clean-heap blocks don't pay a full GC sweep each.
  if not os.getenv('TDOM_NO_CKPT_GC') then
    local kb = collectgarbage('count')
    if kb > (TDOM_GC_FLOOR or 0) + 8192 then
      collectgarbage('collect')
      collectgarbage('collect')
      TDOM_GC_FLOOR = collectgarbage('count')
    end
  end
  -- this child now becomes the next checkpoint in the chain
  CKPT = JOB.ckpt
  conn:send('CKPT ' .. CKPT .. ' ' .. fk.getpid() .. '\n')
  JOB = nil
end

-- ------------------------------------------------------------ shipping

-- Render child: vpack the harvested MVL nodes (the exact nodes the galley
-- reported) and ship them as one tight PDF page.
function tdom_ship()
  local head = harvest_nodes()
  if not head then return end
  -- drop the leading dummy and any held ins nodes: footnote bodies are
  -- placed by the orchestrator's page builder, not inside the block chunk
  -- (they contribute no vertical space in the item stream either). The ins
  -- CONTENT is kept: each footnote body ships as its own tight page after
  -- the floats, so math-bearing footnotes get exact preview chunks too.
  local out = nil
  local tail = nil
  local n = head
  while n do
    local nxt = n.next
    n.next = nil
    n.prev = nil
    if n.id == INS then
      local content = n.head or n.list
      if content then
        FOOT_COPIES[#FOOT_COPIES + 1] = node.vpack(node.copy_list(content))
      end
      node.free(n)
    elseif is_dummy(n) then
      node.free(n)
    else
      if tail then
        tail.next = n
        n.prev = tail
      else
        out = n
      end
      tail = n
    end
    n = nxt
  end
  if not out then return end
  local b = node.vpack(out)
  local w = math.max(b.width or 0, 65536)
  local total = math.max((b.height or 0) + (b.depth or 0), 65536)
  tex.box[255] = b
  tex.pagewidth = w
  tex.pageheight = total
end

-- Render child epilogue: leave the dormant page truly empty so the \end
-- primitive can finalize the PDF without exercising the output routine.
function tdom_render_end()
  local old = tex.lists.page_head
  tex.lists.page_head = nil
  tex.lists.contrib_head = nil
  pcall(function() tex.pagetotal = 0 end)
  if old then node.flush_list(old) end
end

-- Render children: after the main galley page, ship one tight page per
-- captured float box, then one per captured footnote body (queued tokens
-- run before the final \end). Page map: 1 = galley, 2..1+F = floats in
-- order, 2+F..1+F+N = footnote inserts in order.
function tdom_ship_floats()
  local lines = {}
  for i = 1, #FLOAT_COPIES do
    lines[#lines + 1] = '\\directlua{tdom_load_float(' .. i .. ')}'
    lines[#lines + 1] = '\\shipout\\box255'
  end
  for i = 1, #FOOT_COPIES do
    lines[#lines + 1] = '\\directlua{tdom_load_foot(' .. i .. ')}'
    lines[#lines + 1] = '\\shipout\\box255'
  end
  if #lines > 0 then tex.print(lines) end
end

local function load_ship_box(b)
  local w = math.max(b.width or 0, 65536)
  local total = math.max((b.height or 0) + (b.depth or 0), 65536)
  tex.box[255] = b
  tex.pagewidth = w
  tex.pageheight = total
end

function tdom_load_float(i)
  local b = FLOAT_COPIES[i]
  if not b then return end
  FLOAT_COPIES[i] = false
  load_ship_box(b)
end

function tdom_load_foot(i)
  local b = FOOT_COPIES[i]
  if not b then return end
  FOOT_COPIES[i] = false
  load_ship_box(b)
end

-- --------------------------------------------------------- the loop

function tdom_wait()
  while true do
    local line, err = conn:receive('*l')
    if not line then
      fk._exit(0) -- orchestrator went away
    end
    local cmd, a, b, c = line:match('^(%S+)%s*(%S*)%s*(%S*)%s*(%S*)')
    if cmd == 'DIE' then
      fk._exit(0)
    elseif cmd == 'PING' then
      conn:send('PONG ' .. CKPT .. '\n')
    elseif cmd == 'JOB' then
      -- JOB <blockId> <newCkptIdx> <bodyLen>
      local id = a
      local newckpt = tonumber(b) or (CKPT + 1)
      local len = tonumber(c) or 0
      local body = len > 0 and conn:receive(len) or ''
      local pid = fk.fork()
      if pid and pid < 0 then
        texio.write_nl('term and log', 'TDOMFORKFAIL job=' .. tostring(id) .. ' ckpt=' .. tostring(CKPT))
      end
      if pid == 0 then
        JOB = { id = id, ckpt = newckpt, body = body }
        blk_labels = {}
        blk_refs = {}
        blk_counters = {}
        blk_toclines = {}
        blk_events = {}
        blk_gfx = false
        blk_floats = {}
        blk_fonts = {}
        pending_fmarks = {}
        tdom_absorb_reset()
        RENDER_MODE = false
        reconnect('job', newckpt)
        if os.getenv('TDOM_TRACE_HANG') then
          -- hang forensics: if this job burns absurd Lua instruction counts,
          -- dump WHERE and bail — a silent C-side spin never trips this hook
          local ticks = 0
          debug.sethook(function()
            ticks = ticks + 1
            if ticks > 40 then
              texio.write_nl('term and log', 'TDOMHANG job=' .. tostring(id) .. ' ' ..
                debug.traceback('', 2):gsub('\n', ' | '):sub(1, 600))
              io.stdout:write('\n')
              pcall(io.stdout.flush, io.stdout)
              fk._exit(7)
            end
          end, '', 10000000)
        end
        inject_job(body, false)
        return -- resume TeX: typeset, report, then \TDOMloop brings us back
      else
        conn:send('FORKED ' .. id .. ' ' .. pid .. '\n')
      end
    elseif cmd == 'RENDER' then
      local id = a
      local jobdir = b
      local len = tonumber(c) or 0
      local body = len > 0 and conn:receive(len) or ''
      local pid = fk.fork()
      if pid == 0 then
        JOB = { id = id, ckpt = -1, body = body }
        blk_floats = {}
        pending_fmarks = {}
        RENDER_MODE = true
        FLOAT_COPIES = {}
        FOOT_COPIES = {}
        reconnect('render', 0)
        lfs.chdir(jobdir)
        -- under LaTeX, raw callback.register is owned by luatexbase
        local notify = function()
          pcall(function()
            conn:send('DONE ' .. id .. '\n')
          end)
        end
        if luatexbase and luatexbase.add_to_callback then
          pcall(luatexbase.add_to_callback, 'finish_pdffile', notify, 'tdom')
        else
          pcall(callback.register, 'finish_pdffile', notify)
        end
        inject_job(body, true)
        return
      else
        conn:send('FORKED ' .. id .. ' ' .. pid .. '\n')
      end
    end
  end
end

function inject_job(body, ship)
  -- Typeset ON the main vertical list — full state continuity with the
  -- previous blocks (prevdepth, \everypar, spacefactor, open counters...).
  -- The dormant page collects the nodes; tdom_report harvests them.
  local lines = {}
  for l in (body .. '\n'):gmatch('(.-)\n') do
    lines[#lines + 1] = l
  end
  lines[#lines + 1] = '\\par'
  if ship then
    lines[#lines + 1] = '\\directlua{tdom_ship()}'
    lines[#lines + 1] = '\\shipout\\box255'
    lines[#lines + 1] = '\\directlua{tdom_ship_floats()}'
    lines[#lines + 1] = '\\directlua{tdom_render_end()}'
    lines[#lines + 1] = '\\csname @@end\\endcsname'
  else
    for _, name in ipairs(COUNTERS) do
      lines[#lines + 1] = '\\ifcsname c@' .. name .. '\\endcsname\\directlua{tdom_counter(\'' ..
        name .. '\',\\number\\value{' .. name .. '})}\\fi'
    end
    -- \if@nobreak (post-heading state) is part of the exit state vector
    lines[#lines + 1] = '\\csname if@nobreak\\endcsname\\directlua{tdom_counter(\'tdom@nobreak\',1)}' ..
      '\\else\\directlua{tdom_counter(\'tdom@nobreak\',0)}\\fi'
    lines[#lines + 1] = '\\directlua{tdom_report()}'
  end
  tex.print(lines)
end
