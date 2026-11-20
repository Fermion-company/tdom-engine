-- The reference encoder (the one galley hashes were first built on) against the
-- daemon's current one: every value must encode to the same bytes.
-- Run by tests/daemon-json.test.js, which passes the daemon's json section.
local OLD = (function()
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
return jenc end)()
local NEW = assert(load(io.open(arg[1]):read('a') .. '\nreturn jenc', 'daemon-json'))()
math.randomseed(12345)
local words = { 'a', 'text with "quotes"', 'back\\slash', 'tab\there', 'line\nbreak', 'ctl\1\2x', 'あいう', '', 'plain', 'k', 'w', 'runs', 'x:y', 'cr\rlf' }
local function rnd(depth)
  local r = math.random(1, depth > 4 and 6 or 9)
  if r == 1 then return math.random(-100000, 100000)
  elseif r == 2 then return (math.random() - 0.5) * 10 ^ math.random(-6, 14)
  elseif r == 3 then return words[math.random(#words)]
  elseif r == 4 then return math.random() < 0.5
  elseif r == 5 then local pick = { 0 / 0, math.huge, -math.huge, 5.0, 12345678901, -99999999999, 9999999999, 2 ^ 53, 0, -0.0, 1e-7 } return pick[math.random(#pick)]
  elseif r == 6 then return math.random(0, 3)
  elseif r == 7 then local t = {} for i = 1, math.random(0, 6) do t[i] = rnd(depth + 1) end return t
  else local t = {} for _ = 1, math.random(0, 7) do local k = math.random() < 0.9 and words[math.random(#words)] or math.random(2, 40) t[k] = rnd(depth + 1) end
    if t[1] ~= nil then t[1] = nil end return t end
end
local bad = 0
for i = 1, 20000 do
  local v = rnd(0)
  local a, b = OLD(v), NEW(v)
  if a ~= b then bad = bad + 1 if bad < 4 then print('DIFF', a, b) end end
end
-- a galley-shaped value for timing
local function galley()
  local items = {}
  for i = 1, 60 do
    local runs = {}
    for j = 1, 12 do runs[j] = { t = 'これは本文の例文です abc', f = 31, s = 8.5, x = j * 12.25, c = '000000', w = 120.5 } end
    items[#items + 1] = { k = 'box', w = 345.5, h = 8.2, d = 2.1, runs = runs, e = i }
    items[#items + 1] = { k = 'glue', a = 3.5, st = 1, sto = 0, sh = 0, sho = 0 }
  end
  return { block = 'b12', items = items, fonts = { ['31'] = { file = 'x.otf', name = 'X', size = 8.5 } }, state = { page = 3, chapter = 2 }, labels = {}, refs = {} }
end
local g = galley()
assert(OLD(g) == NEW(g))
local function time(f) local t = os.clock() for _ = 1, 200 do f(g) end return (os.clock() - t) / 200 * 1000 end
print(string.format('diffs %d of 20000 | bytes %d | reference %.3f ms  daemon %.3f ms', bad, #NEW(g), time(OLD), time(NEW)))
os.exit(bad == 0 and 0 or 1)
