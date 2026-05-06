/* Phase 0.5 demo fixtures — lifted verbatim from platform/live.html mock data.
 *
 * The data is the same as the prior client-side mock so the spike preserves
 * visual parity. Phase 1 replaces this with real persistence + STT/LLM
 * pipelines.
 *
 * Sentiment changes are merged into aiSequence groups instead of being
 * computed from `at` thresholds inline as the old client did.
 */

export type Who = "agent" | "customer";

export interface ConversationLine {
  who: Who;
  text: string;
  delay: number; // ms from start_call
}

export interface Suggestion {
  type: "direction" | "script" | "alert" | "risk" | "next" | "kb";
  title: string;
  body: string;
  tone: "blue" | "cyan" | "amber" | "rose" | "emerald" | "slate";
}

export interface SuggestionGroup {
  at: number; // ms from start_call
  suggestions: Suggestion[];
  sentiment?: {
    mood: string;
    interest: number;
    stage: string;
  };
}

export const conversation: ConversationLine[] = [
  { who: "agent", text: "안녕하세요, Kloser 고객지원팀 김민수입니다. 무엇을 도와드릴까요?", delay: 0 },
  { who: "customer", text: "안녕하세요. Kloser 도입을 검토 중인데요, 저희가 영업팀이 8명 정도 됩니다.", delay: 4500 },
  { who: "agent", text: "네, 8명 규모시면 Pro 플랜이 가장 적합하실 것 같습니다.", delay: 9000 },
  { who: "customer", text: "저희가 지금 HubSpot을 쓰고 있는데, 데이터 연동이 가능한가요?", delay: 13500 },
  { who: "agent", text: "네, HubSpot 양방향 동기화 기본 지원합니다. 기존 고객·딜 데이터 그대로 가져오실 수 있어요.", delay: 18000 },
  { who: "customer", text: "좋네요. 그러면 가격은 어떻게 되나요? 1인당인가요?", delay: 22500 },
  { who: "agent", text: "아니요, 회사 1곳 기준 정액입니다. Pro는 월 49,000원이고요.", delay: 27000 },
  { who: "customer", text: "음, 8명이 같이 쓰려면 얼마인가요?", delay: 31500 },
  { who: "agent", text: "아 죄송합니다, Pro는 직원 1명 사용 기준이고, 5명까지는 Enterprise 플랜이 필요합니다. 8명이시면 Enterprise + 추가 인원 옵션을 협의드려야 해요.", delay: 36000 },
  { who: "customer", text: "아, 그렇군요. Enterprise는 얼마인가요?", delay: 40500 },
];

export const aiSequence: SuggestionGroup[] = [
  {
    at: 5000,
    suggestions: [
      { type: "direction", title: "응대 방향", body: "회사 규모 청취 완료. 다음은 <b>현재 사용 중인 도구</b>를 자연스럽게 물어보세요.", tone: "blue" },
      { type: "script", title: "추천 멘트", body: '"혹시 지금은 영업 데이터를 어떤 도구로 관리하고 계신가요?"', tone: "cyan" },
    ],
  },
  {
    at: 14000,
    sentiment: { mood: "관심", interest: 92, stage: "검토" },
    suggestions: [
      { type: "alert", title: "핵심 신호 감지", body: "고객이 <b>HubSpot 사용</b>을 언급했습니다. CRM 통합이 결정 요인일 수 있어요.", tone: "amber" },
      { type: "script", title: "추천 멘트", body: '"HubSpot은 양방향 동기화 기본 지원입니다. 기존 데이터 그대로 가져올 수 있어요."', tone: "cyan" },
      { type: "kb", title: "관련 자료", body: "HubSpot 통합 가이드 PDF · 도입 사례: 디자인코", tone: "slate" },
    ],
  },
  {
    at: 23000,
    sentiment: { mood: "망설임", interest: 78, stage: "가격검토" },
    suggestions: [
      { type: "direction", title: "응대 방향", body: "가격 질문 — <b>플랜이 회사 단위 정액</b>임을 명확히 안내하세요. 8명 규모이므로 Enterprise 플랜이 필요합니다.", tone: "blue" },
      { type: "script", title: "추천 멘트", body: '"회사 1곳 기준 정액제이며, Pro는 직원 1명 기준입니다. 5인 팀은 Enterprise(299,000원/월)부터 시작합니다."', tone: "cyan" },
      { type: "risk", title: "주의 포인트", body: "Enterprise는 <b>연간 구독만 가능 · 현장 방문 셋팅 필요</b>를 함께 안내해야 합니다.", tone: "rose" },
    ],
  },
  {
    at: 36500,
    sentiment: { mood: "재고려", interest: 85, stage: "협상" },
    suggestions: [
      { type: "direction", title: "응대 방향", body: "8명 팀이라 <b>Enterprise 5인 + 추가 인원 옵션</b>이 필요. 정확한 견적을 위해 후속 미팅 일정을 제안하세요.", tone: "blue" },
      { type: "script", title: "추천 멘트", body: '"8명 팀이시면 Enterprise 기본 + 직원 3명 추가 옵션이 필요합니다. 정확한 견적과 도입 일정을 위해 30분 화상 미팅 잡으실까요?"', tone: "cyan" },
      { type: "next", title: "다음 액션", body: "✓ 무료 시연 일정 제안<br>✓ 도입 가이드 PDF 발송<br>✓ Enterprise 견적서 준비", tone: "emerald" },
    ],
  },
];
