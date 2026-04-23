// index.js
const express = require('express');
const cors = require('cors');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const app = express();
app.use(cors());
app.use(express.json());

// 1. Initialize the MCP Server
const server = new Server(
  { name: "JouleNorthwindMCPServer", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// 2. Define the available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "get_northwind_summary",
        description: "Returns a high-level summary of the Northwind database entities.",
        inputSchema: {
          type: "object",
          properties: {},
          required: []
        }
      }
    ]
  };
});

// 3. Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "get_northwind_summary") {
    // In a real scenario, you would fetch this from Northwind OData
    return {
      content: [{ 
        type: "text", 
        text: "Northwind contains 91 Customers, 77 Products, and 830 Orders. The system is operating normally." 
      }]
    };
  }
  throw new Error(`Tool not found: ${request.params.name}`);
});

// 4. Expose the MCP Endpoints via Express
let transport;

app.get('/mcp', async (req, res) => {
  transport = new SSEServerTransport('/messages', res);
  await server.connect(transport);
});

app.post('/messages', async (req, res) => {
  if (transport) {
    await transport.handlePostMessage(req, res);
  } else {
    res.status(500).send("Session not initialized");
  }
});

// Start the server (Port 8080 is standard for BTP Cloud Foundry)
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`MCP Server running on port ${PORT}`);
});