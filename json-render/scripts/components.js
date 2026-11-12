// Prints the component lines the json-render-cards skill carries, from
// json-render's own catalog prompt for this plugin's catalog.
// npm run skill
import { componentLines } from '../lib/catalog.js';

console.log(componentLines().join('\n'));
