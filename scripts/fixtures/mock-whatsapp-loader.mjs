export function resolve(specifier, context, nextResolve) {
  if (specifier === '@whiskeysockets/baileys' && context.parentURL?.endsWith('/dist/whatsapp.js')) {
    return { url: new URL('./fake-baileys.mjs', import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
