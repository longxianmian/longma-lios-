/**
 * 后置敏感词过滤。架构改造后，分类 + 模板逻辑已删除——
 * 由统一边界 prompt + factCheck 后置校验来做治理。
 */

const BANNED_WORDS = [
  '知识库', '知識庫', '资料库', '資料庫',
  'KB',
  '系统', '系統',
  'LIOS', 'lios',
  'AI', '人工智慧', '人工智能',
  '模型', 'model',
  'prompt', 'Prompt', 'PROMPT',
  '匹配資料', '匹配资料',
  '索引', 'embedding',
];

export function sanitizeReply(text: string): string {
  let out = (text ?? '').trim();
  for (const w of BANNED_WORDS) {
    if (out.includes(w)) {
      out = out.split(w).join('');
    }
  }
  return out.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

export const PROHIBITED_TECH_WORDS: readonly string[] = BANNED_WORDS;
