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
local PRIVATE_PDF = false
local PDFPATH = ''
local ACTIVE_FEED = ''
local BRANCHDIR = ''

local function send(s) conn:send(s) end

local function connect(role, idx)
  conn = assert(sock.connect('127.0.0.1', PORT))
  conn:setoption('tcp-nodelay', true)
  send('SHELLO ' .. role .. ' ' .. idx .. ' ' .. fk.getpid() .. ' ' .. GEN .. '\n')
end

function tdom_ship_boot(port, workdir, private_pdf)
  PORT = port
  WORKDIR = workdir
  PRIVATE_PDF = tonumber(private_pdf) == 1
  BRANCHDIR = workdir
  PDFPATH = workdir .. '/driver-ship.pdf'
  local shim, lerr = package.loadlib(workdir .. '/tdomfork.so', 'luaopen_tdomfork')
  if not shim then
    texio.write_nl('tdom-ship: FATAL cannot load fork shim: ' .. tostring(lerr))
    os.exit(1)
  end
  fk = shim()
  fk.ignore_sigchld()
  sock = require('socket')
  if PRIVATE_PDF and not lfs.attributes(PDFPATH) then
    -- Give every lineage, including documents without hyperref, a concrete
    -- PDF descriptor before the first shipout. An unreferenced empty object
    -- has no paint effect; it only removes the lazy-open special case so the
    -- same descriptor-clone protocol applies to page 1 and every later page.
    pdf.immediateobj('<<>>')
  end
  connect('root', 0)
end

local function copy_file(source, target)
  local input = io.open(source, 'rb')
  if not input then return false end
  local bytes = input:read('*a')
  input:close()
  local output = assert(io.open(target, 'wb'))
  output:write(bytes)
  output:close()
  return true
end

-- A branch must own every writable output, not only the PDF. Otherwise a
-- paused checkpoint and pager retain the root's shared open-file offsets and
-- append duplicate aux/toc/out records when they continue or finalize.
local OUTPUT_EXTS = {
  'pdf', 'aux', 'toc', 'lof', 'lot', 'out', 'bcf', 'run.xml',
  'idx', 'glo', 'gls', 'nav', 'snm'
}

local function prepare_branch(dir)
  lfs.mkdir(dir)
  local mappings = {}
  for _, ext in ipairs(OUTPUT_EXTS) do
    local source = BRANCHDIR .. '/driver-ship.' .. ext
    local target = dir .. '/driver-ship.' .. ext
    local cloned = fk.copy_open_fd(source, target)
    if not cloned and lfs.attributes(source) then copy_file(source, target) end
    mappings[#mappings + 1] = {source = source, target = target, cloned = cloned, ext = ext}
  end
  if not lfs.attributes(dir .. '/driver-ship.aux') then
    local aux = io.open(dir .. '/driver-ship.aux', 'w')
    if aux then aux:write('\\relax\n') aux:close() end
  end
  return mappings
end

local function adopt_branch(dir, mappings)
  for _, mapping in ipairs(mappings) do
    if mapping.cloned then
      assert(fk.redirect_open_fd(mapping.source, mapping.target),
        'cannot redirect private output ' .. mapping.ext)
    end
  end
  BRANCHDIR = dir
  PDFPATH = dir .. '/driver-ship.pdf'
  assert(lfs.chdir(dir), 'cannot enter private branch directory')
end

local function prepare_private_input()
  if ACTIVE_FEED == '' then return -1 end
  return fk.prepare_read_fd(ACTIVE_FEED)
end

local function adopt_private_input(prepared)
  if prepared and prepared >= 0 then
    assert(fk.adopt_read_fd(ACTIVE_FEED, prepared), 'cannot detach input descriptor')
  end
end

local function wait_as_checkpoint()
  while true do
    local line = conn:receive('*l')
    if not line then fk._exit(0) end
    local cmd, a = line:match('^(%S+)%s*(%S*)')
    if cmd == 'DIE' then
      fk._exit(0)
    elseif cmd == 'RESUME' then
      local resume_gen = tonumber(a) or (GEN + 1)
      -- A checkpoint is immutable and reusable. Fork a continuation instead
      -- of consuming the paused process; a second keystroke can preempt the
      -- first wave and clone the same clean frontier again.
      local resume_dir = WORKDIR .. '/ship-g' .. resume_gen .. '-root-from-' .. PAGE
      local branch = prepare_branch(resume_dir)
      local prepared_input = prepare_private_input()
      local resume_pid = fk.fork()
      if resume_pid == 0 then
        adopt_private_input(prepared_input)
        adopt_branch(resume_dir, branch)
        GEN = resume_gen
        ROLE = 'root'
        EOF = false
        pcall(function() conn:close() end)
        connect('root', PAGE)
        send('SRESUMED ' .. PAGE .. ' ' .. NLINE .. '\n')
        return
      end
      fk.close_fd(prepared_input)
      -- parent remains the frozen checkpoint and waits for another clone
    end
  end
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
  if PRIVATE_PDF then
    -- The replay root's complete, normally finalized PDF is now the only
    -- publishable artifact. Per-page pager forks used to typeset one extra
    -- page each (quadratic work on long documents) and are unnecessary once
    -- tail fragments are no longer exposed. The real root ships normally;
    -- shipout/after alone snapshots the reusable TeX/PDF frontier.
    tex.setcount('global', 'TDOMdiscard', 0)
    return
  end
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
  local mygen = GEN
  local prepared_input = prepare_private_input()
  local pid = fk.fork()
  if pid == 0 then
    adopt_private_input(prepared_input)
    ROLE = 'pager'
    lfs.chdir(dir)
    pcall(function() conn:close() end) -- drop the INHERITED parent fd:
    -- otherwise the parent's socket never closes while children live
    -- HELLO carries the generation; page completion is detected by the
    -- ORCHESTRATOR when this process exits (socket close) — finish_pdffile
    -- fires before the file is fully flushed, so a message from inside the
    -- run can race the conversion reading a truncated PDF
    conn = assert(sock.connect('127.0.0.1', PORT))
    conn:setoption('tcp-nodelay', true)
    send('SHELLO pager ' .. page .. ' ' .. fk.getpid() .. ' ' .. mygen .. '\n')
    tex.setcount('global', 'TDOMdiscard', 0) -- this child ships for real
    return
  end
  fk.close_fd(prepared_input)
  PAGE = page
  send('SSHIP ' .. PAGE .. ' ' .. NLINE .. ' ' .. GEN .. '\n')
  -- resume checkpoint: full state at page PAGE's boundary (its box copy is
  -- discarded on resume exactly like the parent discards it now)
  local cpid = fk.fork()
  if cpid == 0 then
    ROLE = 'ckpt'
    pcall(function() conn:close() end) -- drop the inherited parent fd
    connect('ckpt', PAGE)
    wait_as_checkpoint()
    return
  end
end

-- Inside shipout/after: fires only for REAL shipouts (the pager's page).
function tdom_ship_after()
  if not PRIVATE_PDF or ROLE ~= 'root' then return end
  PAGE = PAGE + 1
  send('SSHIP ' .. PAGE .. ' ' .. NLINE .. ' ' .. GEN .. '\n')
  local checkpoint_page = PAGE
  local checkpoint_gen = GEN
  local checkpoint_dir = WORKDIR .. '/ship-g' .. checkpoint_gen .. '-ck' .. checkpoint_page
  local checkpoint_branch = prepare_branch(checkpoint_dir)
  local prepared_input = prepare_private_input()
  local cpid = fk.fork()
  if cpid == 0 then
    adopt_private_input(prepared_input)
    ROLE = 'ckpt'
    pcall(function() conn:close() end)
    adopt_branch(checkpoint_dir, checkpoint_branch)
    connect('ckpt', checkpoint_page)
    wait_as_checkpoint()
    return
  end
  fk.close_fd(prepared_input)
end

-- ---------------------------------------------------------------- feeder

-- Requests body UNITS from the orchestrator one at a time. A unit is a
-- \par-complete byte slice of the original source: environments never
-- straddle a loop iteration. The bytes are written to a generation-private
-- input file and read by TeX's normal file scanner. This is important for
-- process_input_buffer callbacks (notably LuaTeX-ja); tex.print(body) is not
-- production-equivalent even when its visible characters are identical.
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
local PDFCHECKED = false
function tdom_ship_feed()
  if not PDFCHECKED then
    PDFCHECKED = true
    -- hyperref-class documents write PDF objects during \begin{document}:
    -- the ROOT's pdf is then already open, every pager inherits the shared
    -- fd and the per-page lazy-open scheme cannot work. Report and stop —
    -- the cold canonical owns these documents (same as before phase 1).
    if not PRIVATE_PDF and lfs.attributes(WORKDIR .. '/driver-ship.pdf') then
      send('SPDFROOT\n')
      tex.print('\\csname @@end\\endcsname')
      return
    end
  end
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
  -- Pager branches can legally finish the current unit and ask for more
  -- source before their next shipout is discarded. Never let two forked
  -- processes truncate/rewrite the same feed file while another TeX scanner
  -- still has it open: generation+unit alone is not process-unique.
  local name = 'feed-u' .. NLINE .. '.tex'
  ACTIVE_FEED = BRANCHDIR .. '/' .. name
  local feed = assert(io.open(ACTIVE_FEED, 'wb'))
  feed:write(u)
  feed:close()
  -- Only this small wrapper is injected. The user's source itself passes
  -- through the ordinary TeX input stack, current catcodes and callbacks.
  -- kpathsea retains the process's original working-directory state across
  -- fork/chdir. A relative `feed-uN.tex` can therefore resolve to the stale
  -- generation-0 file even though this branch just wrote a new one. Pin the
  -- exact generation-private source path into TeX's ordinary input scanner.
  tex.sprint('\\input{\\detokenize{' .. ACTIVE_FEED .. '}}')
end
