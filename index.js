// index.js - Simple Stateless MCP Server for Northwind
const express = require('express');
const cors = require('cors');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const app = express();
app.use(cors());
app.use(express.json());

const NORTHWIND_V4_URL = "https://services.odata.org/V4/Northwind/Northwind.svc";

// Helper: Create a fresh MCP server for each request
function createServer() {
    const server = new Server(
        { name: "JouleNorthwindMCPServer", version: "1.0.0" },
        { capabilities: { tools: {} } }
    );

    // Define tools
    server.setRequestHandler(ListToolsRequestSchema, async () => {
        return {
            tools: [
                {
                    name: "get_top_customer",
                    description: "Analyzes the Northwind database to find the customer who has placed the highest number of orders.",
                    inputSchema: { type: "object", properties: {}, required: [] }
                },
                {
                    name: "get_order_details",
                    description: "Retrieves the shipping details and line items for a specific Northwind Order.",
                    inputSchema: {
                        type: "object",
                        properties: { orderId: { type: "number", description: "The unique 5-digit ID of the order (e.g., 10248)." } },
                        required: ["orderId"]
                    }
                },
                {
                    name: "get_customer",
                    description: "Retrieves detailed information about a specific customer from the Northwind database.",
                    inputSchema: {
                        type: "object",
                        properties: { customerId: { type: "string", description: "The unique customer ID (e.g., 'ALFKI', 'BONAP')." } },
                        required: ["customerId"]
                    }
                }
            ]
        };
    });

    // Handle tool execution
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;
        try {
            if (name === "get_top_customer") {
                const response = await fetch(`${NORTHWIND_V4_URL}/Customers?$select=CustomerID,CompanyName&$expand=Orders($select=OrderID)`);
                if (!response.ok) throw new Error(`Northwind API returned ${response.status}`);
                const data = await response.json();
                const customerStats = data.value.map(customer => ({
                    name: customer.CompanyName,
                    id: customer.CustomerID,
                    orderCount: customer.Orders ? customer.Orders.length : 0
                }));
                const topCustomer = customerStats.reduce((prev, current) =>
                    (prev.orderCount > current.orderCount) ? prev : current
                );
                return {
                    content: [{
                        type: "text",
                        text: `The top customer by order volume is ${topCustomer.name} (ID: ${topCustomer.id}) with a total of ${topCustomer.orderCount} orders.`
                    }]
                };
            }

            if (name === "get_order_details") {
                const { orderId } = args;
                if (!orderId) throw new Error("Missing required parameter: orderId");
                if (!Number.isInteger(orderId) || orderId <= 0) throw new Error("orderId must be a positive integer");

                const query = `/Orders(${orderId})?$select=OrderID,OrderDate,ShipCity,ShipCountry&$expand=Order_Details($select=UnitPrice,Quantity,Discount;$expand=Product($select=ProductName))`;
                const response = await fetch(`${NORTHWIND_V4_URL}${query}`);

                if (response.status === 404) {
                    return { content: [{ type: "text", text: `Order ${orderId} was not found in the Northwind database.` }] };
                }
                if (!response.ok) throw new Error(`Northwind API returned ${response.status}`);

                const orderData = await response.json();
                let report = `Order ID: ${orderData.OrderID}\n`;
                const orderDate = orderData.OrderDate ? orderData.OrderDate.split('T')[0] : "Date not available";
                report += `Date: ${orderDate}\n`;
                report += `Destination: ${orderData.ShipCity || "N/A"}, ${orderData.ShipCountry || "N/A"}\n`;
                report += `\nLine Items:\n`;
                if (!orderData.Order_Details || orderData.Order_Details.length === 0) {
                    report += "(No line items found for this order)";
                } else {
                    orderData.Order_Details.forEach(item => {
                        report += `- ${item.Product.ProductName}: ${item.Quantity} units @ $${item.UnitPrice}\n`;
                    });
                }
                return { content: [{ type: "text", text: report }] };
            }

            if (name === "get_customer") {
                const { customerId } = args;
                if (!customerId) throw new Error("Missing required parameter: customerId");
                if (typeof customerId !== "string" || customerId.trim().length === 0) throw new Error("customerId must be a non-empty string");

                const query = `/Customers('${customerId}')?$select=CustomerID,CompanyName,ContactName,ContactTitle,Address,City,PostalCode,Country,Phone,Fax`;
                const response = await fetch(`${NORTHWIND_V4_URL}${query}`);

                if (response.status === 404) {
                    return { content: [{ type: "text", text: `Customer ${customerId} was not found in the Northwind database.` }] };
                }
                if (!response.ok) throw new Error(`Northwind API returned ${response.status}`);

                const customerData = await response.json();
                let report = `Customer ID: ${customerData.CustomerID}\n`;
                report += `Company: ${customerData.CompanyName}\n`;
                report += `Contact: ${customerData.ContactName || "N/A"}\n`;
                report += `Title: ${customerData.ContactTitle || "N/A"}\n`;
                report += `\nAddress:\n`;
                report += `${customerData.Address || "N/A"}\n`;
                report += `${customerData.City || ""} ${customerData.PostalCode || ""}\n`;
                report += `${customerData.Country || "N/A"}\n`;
                report += `\nContact Details:\n`;
                report += `Phone: ${customerData.Phone || "N/A"}\n`;
                report += `Fax: ${customerData.Fax || "N/A"}\n`;
                return { content: [{ type: "text", text: report }] };
            }

            throw new Error(`Tool not found: ${name}`);
        } catch (error) {
            return {
                isError: true,
                content: [{ type: "text", text: `The tool execution failed. Technical detail: ${error.message}` }]
            };
        }
    });

    return server;
}

// MCP endpoint: stateless, one server per request
app.post('/mcp', async (req, res) => {
    try {
        const server = createServer();
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined  // Stateless mode
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        // Clean up when response closes
        res.on('close', async () => {
            await transport.close();
            await server.close();
        });
    } catch (error) {
        console.error('Error handling /mcp request:', error);
        if (!res.headersSent) {
            res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
        }
    }
});

// Health check
app.get('/', (req, res) => {
    res.send("Joule MCP Server is running and healthy! Connect via the /mcp endpoint.");
});

// Start the server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`MCP Server running on port ${PORT}`);
});