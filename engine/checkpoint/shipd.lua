-- shipd.lua — the in-TeX side of the SHIPPING chain (incremental canonical).
--
-- A second resident lualatex runs the document with the REAL output routine.
-- The body is fed line-by-line over the socket, so "how much source a page
-- consumed" is an exact line counter — the resume cursor after an edit.
--
-- At every \shipout:
--   pager child (fork in shipout/before): lfs.chdir's into its page
--     directory — the parent has never opened a PDF, so the lazy open lands
--     there — lets THIS one \shipout complete, then ends the run so luatex
--     finalizes a real single-page PDF (finish_pdffile → SPAGED). The page
--     pixels are byte-honest LuaLaTeX output.
--   parent: \DiscardShipoutBox (its own PDF stays unopened forever), then
--     in shipout/after forks the resume checkpoint: a paused copy holding
--     the complete TeX state right after page k plus the consumed-line
--     cursor. An edit at a line ≥ that cursor resumes from the checkpoint
--     with the NEW tail; everything before is untouched by construction.
--
-- Labels are captured at definition time (driver macro hooks call
-- tdom_ship_label) — the aux file is never trusted or re-read.

local fk = nil
local sock = nil
local lfs = require('lfs')
local conn = nil
local PORT = 0
local WORKDIR = ''
local GEN = 0 -- generation: bumped per resume so page dirs never collide
local PAGE = 0 -- pages shipped so far in this lineage
local NLINE = 0 -- body lines consumed so far (the resume cursor)
local EOF = false
local ROLE = 'root'

local function send(s) conn:send(s) end

local function connect(role, idx)
  conn = assert(sock.connect('127.0.0.1', PORT))
  conn:setoption('tcp-nodelay', true)
  send('SHELLO ' .. role .. ' ' .. idx .. ' ' .. fk.getpid() .. '\n')
end

function tdom_ship_boot(port, workdir)
  PORT = port
  WORKDIR = workdir
  local shim, lerr = package.loadlib(workdir .. '/tdomfork.so', 'luaopen_tdomfork')
  if not shim then
    texio.write_nl('tdom-ship: FATAL cannot load fork shim: ' .. tostring(lerr))
    os.exit(1)
  end
  fk = shim()
  fk.ignore_sigchld()
  sock = require('socket')
  connect('root', 0)
end

-- ---------------------------------------------------------------- labels

function tdom_ship_label(key, val)
  if ROLE == 'pager' then return end
  send('SLABEL ' .. (PAGE + 1) .. ' ' .. #key .. ' ' .. #val .. '\n')
  send(key)
  send(val)
end

-- ---------------------------------------------------------------- shipout

-- Inside shipout/before. ALL bookkeeping lives here: \DiscardShipoutBox
-- cancels shipout/after entirely, and \end inside the output routine is
-- illegal — so the pager must not try to stop here either. Design:
--   parent: set the discard flag GLOBALLY, fork the pager (which flips its
--     own copy back to 0 and really ships), fork the resume checkpoint
--     (inherits discard=1: on RESUME it re-discards its stale box copy and
--     feeds the NEW tail), report SSHIP, then discard.
--   pager: ships exactly once; 'pagerdone' afterwards — further shipouts
--     discard, and the next feeder step (main loop, OUTSIDE the routine)
--     ends the run legally so luatex finalizes the single-page PDF.
function tdom_ship_before()
  if ROLE == 'pager' then
    ROLE = 'pagerdone' -- this ship is mine; the next one is not
    return
  end
  if ROLE == 'pagerdone' then
    tex.setcount('global', 'TDOMdiscard', 1)
    return
  end
  tex.setcount('global', 'TDOMdiscard', 1)
  local page = PAGE + 1
  local dir = WORKDIR .. '/ship-g' .. GEN .. '-p' .. page
  lfs.mkdir(dir)
  -- \enddocument re-inputs \jobname.aux: the pager that ships the FINAL
  -- page (\enddocument's \clearpage) needs one in ITS cwd or it aborts
  -- before finalizing the page PDF
  local aux = io.open(dir .. '/driver-ship.aux', 'w')
  if aux then aux:write('\\relax\n') aux:close() end
  local pid = fk.fork()
  if pid == 0 then
    ROLE = 'pager'
    lfs.chdir(dir)
    pcall(function() conn:close() end) -- drop the INHERITED parent fd:
    -- otherwise the parent's socket never closes while children live
    connect('pager', page)
    local notify = function()
      pcall(function() conn:send('SPAGED ' .. page .. '\n') end)
    end
    if luatexbase and luatexbase.add_to_callback then
      pcall(luatexbase.add_to_callback, 'finish_pdffile', notify, 'tdomship')
    else
      pcall(callback.register, 'finish_pdffile', notify)
    end
    tex.setcount('global', 'TDOMdiscard', 0) -- this child ships for real
    return
  end
  PAGE = page
  send('SSHIP ' .. PAGE .. ' ' .. NLINE .. '\n')
  -- resume checkpoint: full state at page PAGE's boundary (its box copy is
  -- discarded on resume exactly like the parent discards it now)
  local cpid = fk.fork()
  if cpid == 0 then
    ROLE = 'ckpt'
    pcall(function() conn:close() end) -- drop the inherited parent fd
    connect('ckpt', PAGE)
    while true do
      local line = conn:receive('*l')
      if not line then fk._exit(0) end
      local cmd, a = line:match('^(%S+)%s*(%S*)')
      if cmd == 'DIE' then
        fk._exit(0)
      elseif cmd == 'RESUME' then
        GEN = tonumber(a) or (GEN + 1)
        ROLE = 'root'
        EOF = false
        send('SRESUMED ' .. PAGE .. ' ' .. NLINE .. '\n')
        return -- continue as the live parent: discard, then feed new tail
      end
    end
  end
end

-- Inside shipout/after: fires only for REAL shipouts (the pager's page).
function tdom_ship_after()
end

-- ---------------------------------------------------------------- feeder

-- Requests body UNITS from the orchestrator one at a time. A unit is a
-- \par-complete block (the segmenter's unit): environments never straddle a
-- loop iteration, which is the invariant that keeps \halign-style parsers
-- (align, tabular …) away from the loop machinery. The final unit is
-- \end{document} itself, so the run ends through \enddocument.
-- Protocol: SNEED <fromUnit> → SLINE <len>\n<bytes> | SEOF | DIE
local function next_unit()
  if EOF then return nil end
  send('SNEED ' .. (NLINE + 1) .. '\n')
  while true do
    local line = conn:receive('*l')
    if not line then fk._exit(0) end
    local cmd, a = line:match('^(%S+)%s*(%S*)')
    if cmd == 'SLINE' then
      local len = tonumber(a) or 0
      return len > 0 and conn:receive(len) or ''
    elseif cmd == 'SEOF' then
      EOF = true
      return nil
    elseif cmd == 'DIE' then
      fk._exit(0)
    end
  end
end

-- One step of the feeder. Called from the TeX-side tail loop
-- (\TDOMshiploop) so each printed unit is a single input level that opens
-- and CLOSES before the next step — a Lua-side recursion would stack input
-- levels and hit "text input levels=15".
function tdom_ship_feed()
  if ROLE == 'pagerdone' then
    -- main loop, outside any output routine: end the run so luatex
    -- finalizes this pager's single-page PDF (finish_pdffile → SPAGED)
    tex.print('\\csname @@end\\endcsname')
    return
  end
  local u = next_unit()
  if u == nil then
    send('SEND ' .. PAGE .. ' ' .. NLINE .. '\n')
    tex.print('\\csname @@end\\endcsname')
    return
  end
  NLINE = NLINE + 1
  local lines = {}
  for l in (u .. '\n'):gmatch('(.-)\n') do
    lines[#lines + 1] = l
  end
  lines[#lines + 1] = '\\par'
  tex.print(lines)
end
