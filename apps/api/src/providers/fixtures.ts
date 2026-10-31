export const textOnlyFixture = [
  'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}\n\n',
  'data: {"choices":[{"delta":{"content":" world"},"finish_reason":null}]}\n\n',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":6,"completion_tokens":2,"total_tokens":8}}\n\n',
  "data: [DONE]\n\n",
];

export const splitToolCallFixture = [
  'data: {"choices":[{"delta":{"content":null,"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_","arguments":"{\\"pa"}}]},"finish_reason":null}]}\n\n',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"file","arguments":"th\\":\\"README.md\\"}"}}]},"finish_reason":null}]}\n\n',
  'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
  "data: [DONE]\n\n",
];

export const usageFixture = [
  'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":null}]}\n\n',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4,"cost":0.00002}}\n\n',
  "data: [DONE]\n\n",
];

export const providerErrorFixture = ['data: {"error":{"message":"Rate limit exceeded"}}\n\n'];

export const midStreamDisconnectFixture = [
  'data: {"choices":[{"delta":{"content":"This will be cut"},"finish_reason":null}]}\n\n',
];
