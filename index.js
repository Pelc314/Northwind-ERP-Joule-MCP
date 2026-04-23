// index.js - MCP Server for Northwind ERP Operations
const express = require('express');
const cors = require('cors');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const app = express();
app.use(cors());
const jsonParser = express.json();
app.use((req, res, next) => {
    if (req.path === '/messages') {
        return next();
    }
    return jsonParser(req, res, next);
});

// 1. Initialize the MCP Server
const server = new Server(
    { name: "JouleNorthwindMCPServer", version: "1.0.0" },
    { capabilities: { tools: {} } }
);

const NORTHWIND_V4_URL = "https://services.odata.org/V4/Northwind/Northwind.svc";

// 2. Define the available tools and their input schemas
server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: "get_top_customer",
                description: "Analyzes the Northwind database to find the customer who has placed the highest number of orders.",
                inputSchema: {
                    type: "object",
                    properties: {},
                    required: []
                }
            },
            {
                name: "get_order_details",
                description: "Retrieves the shipping details and line items (products, quantities, prices) for a specific Northwind Order.",
                inputSchema: {
                    type: "object",
                    properties: {
                        orderId: {
                            type: "number",
                            description: "The unique 5-digit ID of the order (e.g., 10248)."
                        }
                    },
                    required: ["orderId"]
                }
            },
            {
                name: "get_customer",
                description: "Retrieves detailed information about a specific customer from the Northwind database, including contact info, address, and phone/fax.",
                inputSchema: {
                    type: "object",
                    properties: {
                        customerId: {
                            type: "string",
                            description: "The unique customer ID (e.g., 'ALFKI', 'BONAP')."
                        }
                    },
                    required: ["customerId"]
                }
            }
        ]
    };
});

// 3. Handle actual tool execution with real HTTP requests
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
        // --- TOOL 1: GET TOP CUSTOMER (Aggregation Logic) ---
        if (name === "get_top_customer") {
            // Fetch customers and expand their associated order IDs to minimize payload
            const response = await fetch(`${NORTHWIND_V4_URL}/Customers?$select=CustomerID,CompanyName&$expand=Orders($select=OrderID)`);

            if (!response.ok) throw new Error(`Northwind API returned ${response.status}`);
            const data = await response.json();

            // Perform the aggregation in Node.js
            const customerStats = data.value.map(customer => ({
                name: customer.CompanyName,
                id: customer.CustomerID,
                orderCount: customer.Orders ? customer.Orders.length : 0
            }));

            // Find the customer with the maximum orders
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

        // --- TOOL 2: GET ORDER DETAILS (Dynamic Input Logic) ---
        if (name === "get_order_details") {
            const { orderId } = args;

            // Validate orderId is present and is a valid positive integer
            if (!orderId) throw new Error("Missing required parameter: orderId");
            if (!Number.isInteger(orderId) || orderId <= 0) {
                throw new Error("orderId must be a positive integer");
            }

            // Deep expand: Get the Order -> Order_Details -> Product name
            const query = `/Orders(${orderId})?$select=OrderID,OrderDate,ShipCity,ShipCountry&$expand=Order_Details($select=UnitPrice,Quantity,Discount;$expand=Product($select=ProductName))`;

            const response = await fetch(`${NORTHWIND_V4_URL}${query}`);

            if (response.status === 404) {
                return { content: [{ type: "text", text: `Order ${orderId} was not found in the Northwind database.` }] };
            }
            if (!response.ok) throw new Error(`Northwind API returned ${response.status}`);

            const orderData = await response.json();

            // Format the response nicely for the LLM with safe date parsing
            let report = `Order ID: ${orderData.OrderID}\n`;

            // Safely parse the date; handle null or missing dates
            const orderDate = orderData.OrderDate
                ? orderData.OrderDate.split('T')[0]
                : "Date not available";
            report += `Date: ${orderDate}\n`;

            report += `Destination: ${orderData.ShipCity || "N/A"}, ${orderData.ShipCountry || "N/A"}\n`;
            report += `\nLine Items:\n`;

            // Handle empty order details gracefully
            if (!orderData.Order_Details || orderData.Order_Details.length === 0) {
                report += "(No line items found for this order)";
            } else {
                orderData.Order_Details.forEach(item => {
                    report += `- ${item.Product.ProductName}: ${item.Quantity} units @ $${item.UnitPrice}\n`;
                });
            }

            return {
                content: [{ type: "text", text: report }]
            };
        }

        // --- TOOL 3: GET CUSTOMER (Customer Details Lookup) ---
        if (name === "get_customer") {
            const { customerId } = args;

            // Validate customerId is present and is a non-empty string
            if (!customerId) throw new Error("Missing required parameter: customerId");
            if (typeof customerId !== "string" || customerId.trim().length === 0) {
                throw new Error("customerId must be a non-empty string");
            }

            const query = `/Customers('${customerId}')?$select=CustomerID,CompanyName,ContactName,ContactTitle,Address,City,PostalCode,Country,Phone,Fax`;

            const response = await fetch(`${NORTHWIND_V4_URL}${query}`);

            if (response.status === 404) {
                return { content: [{ type: "text", text: `Customer ${customerId} was not found in the Northwind database.` }] };
            }
            if (!response.ok) throw new Error(`Northwind API returned ${response.status}`);

            const customerData = await response.json();

            // Format customer information for the LLM
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

            return {
                content: [{ type: "text", text: report }]
            };
        }

        // Fallback for unknown tools
        throw new Error(`Tool not found: ${name}`);

    } catch (error) {
        // Return a graceful error to Joule so it can inform the user, rather than crashing the agent
        return {
            isError: true,
            content: [{
                type: "text",
                text: `The tool execution failed. Technical detail: ${error.message}`
            }]
        };
    }
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