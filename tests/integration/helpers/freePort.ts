import { createServer } from "node:net";

/**
 * 向系统要一个当前空闲的回环端口。
 *
 * 测试文件并行运行；各自手写一段固定端口，段一旦重叠，或上一轮遗留的进程占着某个端口，
 * 用例就会随机失败。这里用 `listen(0)` 由内核分配再立即关闭：关闭与子进程重新监听之间
 * 仍有极小的窗口，但内核分配时会避开刚释放的端口，比固定段可靠得多。
 */
export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (address === null || typeof address === "string") throw new Error("拿不到分配的端口");
  return address.port;
}
