-- Run in LuaTeX's Lua-only mode: the same ABI as the daemon, without TeX or forks.
local loader, err = package.loadlib(arg[1], 'luaopen_tdomfork')
assert(loader, err)
local shim = loader()
for _, name in ipairs({
  'fork', 'set_interactive', 'getpid', 'waitpid', '_exit', 'ignore_sigchld',
  'clone_open_fd', 'copy_open_fd', 'prepare_pdf', 'fork_pdf', 'publish_pdf',
  'redirect_open_fd', 'prepare_read_fd', 'adopt_read_fd', 'close_fd', 'flush',
}) do
  assert(type(shim[name]) == 'function', 'tdomfork.so missing function: ' .. name)
end
assert(shim.getpid() > 0)
assert(shim.flush(), 'tdomfork.so flush failed')
print('TDOM_SHIM_OK')
