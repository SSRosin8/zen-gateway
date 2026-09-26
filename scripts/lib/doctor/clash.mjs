// doctor 第 5 层：Clash 控制面。实现与管理面诊断共用，见 `src/core/proxy/clash/diagnose.ts`。
import { diagnoseClash } from "../../../src/core/proxy/clash/diagnose.ts";

export async function layerClashControl(ctx) {
  return await diagnoseClash(ctx.config);
}
