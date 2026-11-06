/** Preload only in process tests: never initialize a real WhatsApp transport. */
import { register } from 'node:module';
register('./mock-whatsapp-loader.mjs', import.meta.url);
