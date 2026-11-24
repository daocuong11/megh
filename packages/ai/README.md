# @meghjs/ai

Turn [Megh](https://github.com/meghjs/megh) routes into LLM tools. Mark a
route with `@Tool()` and a model can call it, through the same pipeline as an
HTTP request: middleware, authentication, `@Authorized`, validation, rate
limits and exception filters.

```sh
npm install @meghjs/ai
```

It's a Megh plugin, so it loads by itself once it's installed.

```ts
import { Tool, ToolSet } from "@meghjs/ai";

@ApiController("/orders")
export class OrderController {
  @Get("/:id")
  @Authorized()
  @Tool({ description: "Look up one order by its ID, with its items and status." })
  find(@Param("id") id: string) { ... }

  @Post("/:id/refund")
  @Authorized("admin")
  @Tool({ description: "Refund an order, fully or in part.", confirm: true })
  refund(@Param("id") id: string, @Body() body: RefundDto) { ... }
}

// In any controller or service:
constructor(private readonly tools: ToolSet) {}

this.tools.forAnthropic();   // [{ name, description, input_schema }]
this.tools.forOpenAI();      // [{ type: "function", function: { ... } }]
this.tools.forMcp();         // [{ name, description, inputSchema, annotations }]

// Run the model's tool calls as the signed-in user:
await this.tools.anthropicResults(response.content, { request: req });
await this.tools.openAIResults(message.tool_calls, { request: req });
await this.tools.call("order_find", { id: "42" }, { request: req });
```

- The input schema comes from the route's path parameters, `@Query()` and
  `@Body()` DTO.
- `confirm: true` tools don't run without `confirmed: true`: a person approves
  them first.
- Errors come back as results (`ok: false`, `status`, `content`) the model can
  correct itself from.
- Responses are capped (`maxOutput`, default 20 000 characters), and each call
  is logged with the tool, status, duration and request ID.

## Serve them over MCP

```sh
npm install @modelcontextprotocol/sdk
```

```ts
app.useMcp({ tools: { tags: ["public"] } });   // Streamable HTTP at /mcp
```

Clients sign in like any API client (bearer token, API key), and each tool
call runs as that caller through its route's own `@Authorized`. A
`confirm: true` tool asks the user through the client before it runs (MCP
elicitation); `confirm: "client"` or `"refuse"` change that. Sessions are
bound to the credentials that opened them; `sessions: false` runs stateless.

`megh route:list` shows a **TOOL** column for these routes, and the
[`@meghjs/mcp`](../mcp) server's `megh_list_ai_tools` lists them with safety
warnings.

Docs: **https://meghjs.github.io/ai/tools**

## License

MIT
