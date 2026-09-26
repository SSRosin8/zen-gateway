// 测试只允许连本机回环地址。经 NODE_OPTIONS=--import 注入，测试进程和它启动的子进程
// （服务、doctor、setup）都生效：连外网的用例在不同机器上结果不同，这里让它当场失败。
import net from "node:net";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";

const loopback = new net.BlockList();
loopback.addSubnet("127.0.0.0", 8, "ipv4");
loopback.addAddress("::1", "ipv6");
// 本机网卡地址也算本机：回环守卫的用例要从非回环地址连自己，验证远端被拒。
for (const addrs of Object.values(networkInterfaces())) {
  for (const a of addrs ?? []) loopback.addAddress(a.address.split("%")[0], a.family === "IPv6" ? "ipv6" : "ipv4");
}

function isLocal(host) {
  if (host === undefined || host === "localhost") return true;
  const bare = host.replace(/^\[|\]$/g, "");
  const family = isIP(bare);
  if (family === 0) return false;
  return loopback.check(bare, family === 6 ? "ipv6" : "ipv4") || bare === "0.0.0.0";
}

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  // net.connect() 传进来的是已归一化的 [[options, cb]]；直接调用 socket.connect() 则是原始参数。
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const opts = typeof first === "object" && first !== null ? first : { port: first, host: args[1] };
  if (opts.path === undefined && !isLocal(opts.host)) {
    const err = new Error(`测试禁止访问外网：${opts.host}:${opts.port}`);
    err.code = "ZG_OFFLINE_GUARD";
    process.nextTick(() => this.destroy(err));
    return this;
  }
  return connect.apply(this, args);
};
