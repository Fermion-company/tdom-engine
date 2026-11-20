-- Galleys as jenc writes them and as jenc_wire sends them, one pair of lines a
-- case. Run by tests/daemon-json.test.js, which passes the daemon's json
-- section and checks that the second line unpacks to the first.
local jenc, jenc_wire = assert(load(io.open(arg[1]):read('a') .. '\nreturn jenc, jenc_wire', 'daemon-json'))()
local function rule(x, ra, extra)
  local r = { rule = true, rv = 2, rs = 3, rw = 0, rh = 461373, rd = 62915, ri = 0, rl = 0, rr = 0, rdir = 'TLT',
    ra = ra, x = x, dy = -7.013692, w = 0, h = 7.970112, c = '#000000' }
  for k, v in pairs(extra or {}) do r[k] = v end
  return r
end
local function glyph(x, t)
  return { c = '#000000', dy = 0, f = 20, gd = 0.879, gh = 8.8, s = 10.087796, t = t, w = 10.087796, x = x }
end
local A, B, C = '0:0,4:2,5:53,6:-4,11:0', '0:0,4:2,5:53,6:-4,7:15,11:0', '0:0,4:2,5:53,6:-4,7:16,11:0'
local cases = {}
-- kinds interleaved, glyphs between
cases[#cases + 1] = { items = { { k = 'box', h = 8, d = 2, runs = {
  glyph(0, 'あ'), rule(10.1, A), glyph(10.1, 'い'), rule(20.2, B), rule(20.2, A), glyph(20.2, 'う'), rule(30.3, C),
  rule(30.3, B), rule(40.4, A), glyph(40.4, 'a"b\\c'), rule(50.5, C) } }, { k = 'glue', a = 3.5 } } }
-- a rule of another shape in the middle: the count of whole rules goes on
local odd = rule(15, A); odd.ri = nil
cases[#cases + 1] = { items = { { k = 'box', runs = { rule(1, A), rule(2, A), odd, rule(3, A), rule(4, B), rule(5, A), rule(6, B) } } } }
-- alike to == but not on the wire (0 and -0.0), alike on the wire (5 and 5.0)
cases[#cases + 1] = { items = { { k = 'box', runs = {
  rule(1, A), rule(2, A, { rw = -0.0 }), rule(3, A, { rw = -0.0 }), rule(4, A, { rh = 461373.0 }), rule(5, A, { dy = -7.5 }), rule(6, A) } } } }
-- more kinds than are looked back over, then the first again, twice
local many = {}
for i = 1, 12 do many[#many + 1] = rule(i, 'k:' .. i) end
many[#many + 1] = rule(13, 'k:1'); many[#many + 1] = rule(14, 'k:1'); many[#many + 1] = rule(15, 'k:12')
cases[#cases + 1] = { items = { { k = 'box', runs = many } } }
-- run lists elsewhere, an empty one, a `runs` that is no list, a rule outside any list, odd numbers
cases[#cases + 1] = { runs = { a = 1 }, lone = rule(9, A), floats = { { items = { { k = 'box', runs = { rule(1, B), rule(2, B) } }, { k = 'box', runs = {} } } } },
  hf = { p1 = { h = { { k = 'box', runs = { rule(0 / 0, A), rule(1e12, A), rule(-3, A), glyph(5, 'x') } } } } } }
-- many, at random
math.randomseed(4711)
local kinds = { A, B, C, 'k:x', 'k:y', 'k:z' }
local long = {}
for i = 1, 2000 do
  if math.random() < 0.45 then long[i] = glyph(i * 1.5, 'か') else long[i] = rule(math.random() * 400, kinds[math.random(#kinds)]) end
end
cases[#cases + 1] = { block = 'b1', items = { { k = 'box', runs = long } }, w = 345.5 }
for _, v in ipairs(cases) do
  print(jenc(v))
  print(jenc_wire(v))
end
