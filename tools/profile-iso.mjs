// Measurement-only preload: --import ./tools/profile-iso.mjs, then run the
// rescue benchmark with --keep and TDOM_ISO_KEEP=1. profile.tsv records wall
// time, child CPU and Lua heap at nested environment/font/ship boundaries.
import { Peer } from '../engine/checkpoint/peer.js';

const send = Peer.prototype.send, raw = Peer.prototype.sendRaw;
const envs = ['multicols', 'multicols*', 'textbox', 'tcolorbox', 'tblr', 'tikzpicture',
  'equation', 'align', 'theorem', 'proof', 'itemize'];
const setup = String.raw`\directlua{
  TDOMprof=io.open('profile.tsv','w')
  function tdomprof(s)
    TDOMprof:write(s,' ',socket.gettime(),' ',os.clock(),' ',collectgarbage('count'),string.char(10))
    TDOMprof:flush()
  end
  tdomprof('start')
  for _,desc in ipairs(luatexbase.callback_descriptions('define_font')) do
    local f=luatexbase.remove_from_callback('define_font',desc)
    luatexbase.add_to_callback('define_font',function(...)
      tdomprof('font:before:'..tostring(select(1,...))..':'..tostring(select(2,...)))
      local r=f(...) tdomprof('font:after') return r
    end,desc)
  end
  luatexbase.add_to_callback('finish_pdffile',function() tdomprof('finishpdf') end,'tdom-profile')
  luatexbase.add_to_callback('stop_run',function() tdomprof('stop') TDOMprof:close() end,'tdom-profile')
}` + '\n' + ['para/before', 'para/after', 'shipout/before', 'shipout/after',
  'cmd/balance@columns/before', 'cmd/balance@columns/after'].map(h =>
  String.raw`\AddToHook{${h}}{\directlua{tdomprof('${h}')}}`).join('\n') + '\n' + envs.map(e =>
  String.raw`\AddToHook{env/${e}/before}{\directlua{tdomprof('${e}:before')}}\AddToHook{env/${e}/after}{\directlua{tdomprof('${e}:after')}}`
).join('\n') + '\n';

Peer.prototype.send = function (line) {
  if (line.startsWith('ISO ')) { this.profileLine = line; return; }
  return send.call(this, line);
};
Peer.prototype.sendRaw = function (body) {
  if (!this.profileLine) return raw.call(this, body);
  const line = this.profileLine;
  this.profileLine = null;
  const instrumented = Buffer.from(setup + body.toString());
  send.call(this, line.replace(/\d+\n$/, instrumented.length + '\n'));
  return raw.call(this, instrumented);
};
