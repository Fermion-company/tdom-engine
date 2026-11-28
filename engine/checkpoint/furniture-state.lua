-- The values in a furniture snapshot come from LuaTeX's current eqtb.
-- Keys absent from the delta have the baseline meaning in this TeX run.
local M = {}
local macroChecks
local macroPrefixes = {
  macro = '', long = '\\long', protected = '\\protected', ['protected-long'] = '\\protected\\long'
}
local macroCommands = {call = true, long_call = true, outer_call = true, long_outer_call = true}
local create, command, mode = token.create, token.get_command, token.get_mode
local countCommand = token.command_id('assign_int')
local dimenCommand = token.command_id('assign_dimen')
local getcount, getdimen = tex.getcount, tex.getdimen

function tdom_furniture_macro_confirmed(index)
  macroChecks[index].confirmed = true
end

local function macroCheck(name, value, kind, index)
  -- Compare the retokenized definition with the real token list. \meaning
  -- alone cannot distinguish a letter from an active or other character.
  return ('\\begingroup%s\\def\\TDOMFurnitureCheck{%s}' ..
    '\\expandafter\\ifx\\csname %s\\endcsname\\TDOMFurnitureCheck' ..
    '\\directlua{tdom_furniture_macro_confirmed(%d)}\\fi\\endgroup'):format(macroPrefixes[kind], value, name, index)
end

function tdom_hf_replay_macro(name, hex, kind)
  local value = hex:gsub('..', function(pair) return string.char(tonumber(pair, 16)) end)
  local catcodes = token.create('catcodetable@atletter').index
  local definition = ('%s\\expandafter\\def\\csname %s\\endcsname{%s}'):format(
    macroPrefixes[kind], name, value)
  tex.sprint(catcodes, ('\\catcodetable%d\\relax\\endlinechar=-1\\relax\\scantokens{%s}' ..
    '\\endlinechar=%d\\relax\\catcodetable%d\\relax'):format(catcodes, definition, tex.endlinechar, tex.catcodetable))
end

local function candidateText(meaning)
  local text = meaning:match('^%-%>(.*)$')
  if not text or #text > 512 or text:find('[#%%\r\n]') or text:find('^^', 1, true) then return end
  local depth = 0
  local cursor = 1
  while cursor <= #text do
    local c = text:sub(cursor, cursor)
    if c == '\\' then
      cursor = cursor + 1
      if cursor > #text then return end
    elseif c == '{' then depth = depth + 1
    elseif c == '}' then
      depth = depth - 1
      if depth < 0 then return end
    end
    cursor = cursor + 1
  end
  if depth == 0 then return text end
end

local function descriptor(name, t)
  local cmd = t.cmdname
  if cmd == 'undefined_cs' then return end
  if macroCommands[cmd] then
    local value = token.get_meaning(name)
    if not value then return end
    -- get_meaning exposes the parameter and replacement text only. The
    -- native protected bit is part of the meaning too (e.g. inside an edef).
    local protected = t.protected
    local meaning = (protected and 'protected:' or '') .. cmd .. ':' .. value
    return meaning, value, cmd, protected
  end
  local value
  if cmd == 'assign_int' then
    value = tex.getcount(name)
  elseif cmd == 'assign_dimen' then
    value = tex.getdimen(name)
  end
  return cmd .. ':' .. tostring(t.mode) .. ':' .. tostring(value), value, cmd
end

local function ambient()
  local id = font.current()
  local f = font.getfont(id) or {}
  return table.concat({f.filename or '', f.fullname or f.name or id, f.size or 0, f.specification and f.specification.hash or ''}, ':'),
    (token.get_macro('current@color') or '')
end

function M.fingerprint(name)
  local meaning
  if name == '$font' then meaning = ambient()
  elseif name == '$color' then
    local _, color = ambient()
    meaning = color
  else
    local t = token.create(name)
    if t and t.csname == name then meaning = descriptor(name, t) end
  end
  return meaning and md5.sumhexa(meaning) or ''
end

function M.capture(baseline, fingerprintsOnly, pinned, watched, skipAmbient, memo)
  local result = {}
  local on, off, toggleOn, toggleOff
  local pending = memo and {}
  local tokens = pinned and pinned.tokens
  local meanings = pinned and pinned.meanings
  local registers = pinned and pinned.registers
  for _, name in ipairs(watched) do
    local t = (tokens and tokens[name]) or create(name)
    local saved = meanings and meanings[name]
    local key, register
    local same = false
    if t and (saved or memo) then
      local cmd = command(t)
      key = (mode(t) << 16) | cmd
      if cmd == countCommand then
        register = getcount(name)
        same = key == saved and register == registers[name]
      elseif cmd == dimenCommand then
        register = getdimen(name)
        same = key == saved and register == registers[name]
      else
        same = key == saved
      end
    end
    local cached = not same and memo and memo.records[name]
    if not same and cached and cached.key == key and cached.register == register then
      if cached.record then result[#result + 1] = cached.record end
    elseif not same then
      local meaning, value, cmd, protected
      local record
      if t then meaning, value, cmd, protected = descriptor(name, t) end
      if not baseline then
        result[name] = meaning
      elseif meaning and baseline[name] ~= meaning then
        local kind, replay
        if name:match('^[%a@:_][%w@:_]*$') then
          if cmd == 'if_test' then
            on, off = on or create('iftrue'), off or create('iffalse')
            if t.mode == on.mode then kind, replay = 'let', 'iftrue' end
            if t.mode == off.mode then kind, replay = 'let', 'iffalse' end
          elseif not protected and value and cmd == 'long_call' then
            toggleOn = toggleOn or token.get_meaning('etb@toggletrue')
            toggleOff = toggleOff or token.get_meaning('etb@togglefalse')
            if value == toggleOn or value == toggleOff then
              kind, replay = 'let', value == toggleOn and 'etb@toggletrue' or 'etb@togglefalse'
            end
          end
          if not kind and not fingerprintsOnly and cmd == 'assign_int' and t.index and type(value) == 'number' then
            kind, replay = 'count', value
          elseif not kind and not fingerprintsOnly and cmd == 'assign_dimen' and t.index and type(value) == 'number' then
            kind, replay = 'dim', value
          elseif not kind and not fingerprintsOnly and type(value) == 'string' and (cmd == 'call' or cmd == 'long_call') then
            replay = candidateText(value)
            if replay then
              if protected then kind = cmd == 'long_call' and 'check-protected-long' or 'check-protected'
              else kind = cmd == 'long_call' and 'check-long' or 'check-macro' end
            end
          end
        end
        record = {name, md5.sumhexa(meaning), kind or '', replay or ''}
      elseif not meaning and baseline[name] then
        record = {name, '', '', ''}
      end
      if record then result[#result + 1] = record end
      if memo and not macroCommands[cmd] then
        memo.records[name] = { key = key, register = register, record = record }
      elseif memo and (tex.globaldefs or 0) >= 0 then
        local alias = memo.aliases[name]
        if not alias then
          local hold = 'TDOM@hfOutput' .. tostring(memo.nextAlias)
          memo.nextAlias = memo.nextAlias + 1
          token.set_macro(hold, '', 'global')
          alias = create(hold)
          memo.aliases[name] = alias
        end
        local i = #pending
        pending[i + 1], pending[i + 2], pending[i + 3], pending[i + 4] = memo.global, memo.let, alias, t
        memo.records[name] = { key = key, record = record }
      end
    end
  end
  if pending and #pending > 0 then token.put_next(pending) end
  if not skipAmbient then
    local f, c = ambient()
    if not baseline then
      result['$font'], result['$color'] = f, c
    else
      if f ~= baseline['$font'] then result[#result + 1] = {'$font', md5.sumhexa(f), '', ''} end
      if c ~= baseline['$color'] then result[#result + 1] = {'$color', md5.sumhexa(c), '', ''} end
    end
  end
  if baseline and not skipAmbient then table.sort(result, function(a, b) return a[1] < b[1] end) end
  return result
end

-- A root macro's token-list address identifies its meaning while a TeX
-- alias holds a reference to the list. Pin the baseline once so a resident
-- block need only serialize definitions that actually changed. Keep the
-- full textual fingerprint on the wire, where addresses have no meaning.
function M.pinBaseline(baseline)
  local pinned, input = { meanings = {}, registers = {}, tokens = {} }, {}
  local let = token.create('let')
  if not let or let.cmdname ~= 'let' or (tex.globaldefs or 0) ~= 0 then return end
  for name in pairs(baseline) do
    if name:sub(1, 1) ~= '$' then
      local t = token.create(name)
      if t and t.csname == name then
        local cmd = command(t)
        -- The handle names the control sequence. Its getters still read
        -- the live definition even after a body assignment.
        pinned.tokens[name] = t
        pinned.meanings[name] = (mode(t) << 16) | cmd
        if cmd == countCommand then pinned.registers[name] = getcount(name)
        elseif cmd == dimenCommand then pinned.registers[name] = getdimen(name) end
        if macroCommands[t.cmdname] then
          local alias = 'TDOM@hfHold' .. #input
          token.set_macro(alias, '', 'global')
          local i = #input
          input[i + 1], input[i + 2], input[i + 3] = let, token.create(alias), t
        end
      end
    end
  end
  if #input > 0 then token.put_next(input) end
  return pinned
end

function M.prepareChecks(observations)
  local catcodes = token.create('catcodetable@atletter').index
  local byKey, commands = {}, {}
  macroChecks = {}
  for _, values in ipairs(observations) do
    for _, record in ipairs(values) do
      local name, fingerprint, kind, value = table.unpack(record)
      local recipe = kind:match('^check%-(.+)$')
      if recipe and macroPrefixes[recipe] then
        local key = name .. ':' .. fingerprint
        local check = byKey[key]
        if not check then
          check = {records = {}, kind = recipe}
          byKey[key] = check
          macroChecks[#macroChecks + 1] = check
          if catcodes and (tex.globaldefs or 0) == 0 and M.fingerprint(name) == fingerprint then
            commands[#commands + 1] = macroCheck(name, value, check.kind, #macroChecks)
          end
        end
        check.records[#check.records + 1] = record
      end
    end
  end
  -- Queue normal TeX input. Running a nested interpreter here can disturb
  -- the page builder when the resident is still holding contributed nodes.
  if #commands > 0 then tex.sprint(catcodes, commands) end
end

function M.finishChecks()
  for _, check in ipairs(macroChecks or {}) do
    for _, record in ipairs(check.records) do
      if check.confirmed then record[3] = check.kind
      else record[3], record[4] = '', '' end
    end
  end
  macroChecks = nil
end

function M.canonical()
  local clock = os.gettimeofday or os.clock
  local started = clock()
  local filename = os.getenv('TDOM_FURNITURE_WATCH')
  local watch = filename and filename ~= '' and io.open(filename, 'r')
  if not watch then return end
  local names, countFolio = {}, false
  for name in watch:lines() do
    if name == 'c@page' then countFolio = true
    else names[#names + 1] = name end
  end
  watch:close()
  if #names == 0 and not countFolio then return end

  local baseline, pinned, memo, pageState, page = nil, nil, nil, nil, 0
  local previous = {}
  local elapsed = 0
  local function hook(name, body)
    tex.sprint('\\AddToHook{' .. name .. '}{\\directlua{' .. body .. '}}')
  end
  function tdom_canonical_furniture_begin()
    local begin = clock()
    local ok, values = pcall(M.capture, nil, true, nil, names, true)
    if ok then
      baseline = values
      pinned = M.pinBaseline(baseline)
      local global, let = create('global'), create('let')
      if global.cmdname == 'prefix' and let.cmdname == 'let' then
        -- An alias keeps the observed token list live. Its address can be
        -- compared on the next sheet without converting it to text again.
        memo = { global = global, let = let, records = {}, aliases = {}, nextAlias = 1 }
      end
    end
    elapsed = elapsed + clock() - begin
  end
  function tdom_canonical_furniture_output()
    pageState = nil
    if not baseline then return end
    local begin = clock()
    local folio = countFolio and tex.getcount('c@page') or '-'
    local ok, values = pcall(M.capture, baseline, true, pinned, names, true, memo)
    if ok then pageState = {folio, values} end
    elapsed = elapsed + clock() - begin
  end
  local function writeValue(name, digest, kind)
    local hex = name:gsub('.', function(c) return ('%02x'):format(c:byte()) end)
    for start = 1, #hex, 44 do texio.write_nl('log', 'TDOMHF N ' .. hex:sub(start, start + 43)) end
    texio.write_nl('log', 'TDOMHF V ' .. digest .. (kind == 'let' and ' switch' or ''))
  end
  function tdom_canonical_furniture_ship()
    page = page + 1
    if pageState then
      local begin = clock()
      texio.write_nl('log', 'TDOMHF P ' .. page .. ' ' .. pageState[1])
      local current = {}
      for _, value in ipairs(pageState[2]) do
        local name, digest, kind = table.unpack(value)
        current[name] = digest
        if previous[name] ~= digest then writeValue(name, digest ~= '' and digest or '-', kind) end
      end
      for name in pairs(previous) do if current[name] == nil then writeValue(name, '+') end end
      previous = current
      texio.write_nl('log', 'TDOMHF E')
      pageState = nil
      elapsed = elapsed + clock() - begin
    end
  end
  function tdom_canonical_furniture_finish()
    texio.write_nl('term and log', 'TDOMHF T ' .. math.floor(elapsed * 1000000 + 0.5))
  end
  hook('begindocument/end', 'tdom_canonical_furniture_begin()')
  hook('cmd/@outputpage/before', 'tdom_canonical_furniture_output()')
  -- Number only pages that actually shipped. Earlier shipout hooks can
  -- discard a box without adding a physical sheet to the PDF.
  hook('shipout/after', 'tdom_canonical_furniture_ship()')
  hook('enddocument/afterlastpage', 'tdom_canonical_furniture_finish()')
  elapsed = clock() - started
end

return M
