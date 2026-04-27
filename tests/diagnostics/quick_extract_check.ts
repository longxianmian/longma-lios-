import 'dotenv/config';
import { ClaimExtractor } from '../../src/extractor/ClaimExtractor';

(async () => {
  const e = new ClaimExtractor();
  const cs = await e.extract('我買的大鵝羽絨服是殘次品', { tenant_id: 'demo' });
  console.log('claims =', cs.length);
  for (const c of cs) {
    console.log('  -', c.type, 'confidence=', c.confidence, 'content=', JSON.stringify(c.content));
  }
})();
