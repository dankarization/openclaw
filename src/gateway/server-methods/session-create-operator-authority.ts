import { captureGatewayOperatorRunAuthority } from "../operator-run-authority.js";

export function captureSessionCreateOperatorAuthority(
  params: Parameters<typeof captureGatewayOperatorRunAuthority>[0],
) {
  const preparation = captureGatewayOperatorRunAuthority(params);
  void preparation.catch(() => {});
  return {
    preparation,
    async [Symbol.asyncDispose]() {
      const captured = await preparation.catch(() => undefined);
      captured?.release();
    },
  };
}
