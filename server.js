const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const {
  StreamableHTTPServerTransport,
} = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { z } = require("zod");
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const nodemailer = require("nodemailer");
const {
  productSearchByQuery,
  productByIdQuery,
  productSortQuery,
  discountQuery,
} = require("./graphql_queries");
const {
  MCP_NAME,
  MCP_VERSION,
  SMTP_USER,
  SMTP_PASS,
  ZENDESK_USERNAME,
  ZENDESK_PASSWORD,
  ZENDESK_API_URL,
  SHOPIFY_BASE_URL,
  SHOPIFY_ACCESS_TOKEN,
  callShopifyApi,
  callBackendAPI,
  formatProducts,
  extractSearchTerms,
  fetchRelatedProducts,
  getProductSortConfig,
  storeMetadata,
  logProductViewEvents,
  parseSpaceInput,
  extractDimensions,
  normalizeDims,
  getRelevanceScore,
  formatDiscounts,
  formatOrder,
} = require("./utils");

const { getCache, setCache } = require("./cache");

// Initialize the MCP server
const server = new McpServer({
  name: MCP_NAME,
  version: MCP_VERSION,
  capabilities: {
    tools: true,
    resources: true,
  },
});

// Configure Nodemailer transporter for sending OTP emails using SMTP credentials from environment variables.
const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false,
  auth: {
    user: SMTP_USER,
    pass: SMTP_PASS,
  },
});

/**
 * ShopifyOrderEditor — implements the 3-step Order Edit API:
 *   Step 1: orderEditBegin      → obtain a calculatedOrder ID
 *   Step 2: apply mutations     → addVariant | setQuantity | removeLineItem
 *   Step 3: orderEditCommit     → persist changes and optionally notify customer
 *
 * Derives the shop domain from SHOPIFY_BASE_URL (e.g. https://xxx.myshopify.com)
 * and the access token from SHOPIFY_ACCESS_TOKEN — both already defined in .env.
 */
class ShopifyOrderEditor {
  constructor() {
    // Parse hostname from SHOPIFY_BASE_URL (e.g. "https://blushora-pdczux7n.myshopify.com")
    const baseUrl = SHOPIFY_BASE_URL || "";
    this.shopDomain = baseUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");
    this.accessToken = SHOPIFY_ACCESS_TOKEN;
    this.apiVersion = process.env.SHOPIFY_API_VERSION || "2024-04";
    this.graphqlEndpoint = `https://${this.shopDomain}/admin/api/${this.apiVersion}/graphql.json`;
  }

  async _graphql(query, variables = {}) {
    const response = await axios.post(
      this.graphqlEndpoint,
      { query, variables },
      {
        headers: {
          "X-Shopify-Access-Token": this.accessToken,
          "Content-Type": "application/json",
        },
      },
    );
    const { data, errors } = response.data;
    if (errors?.length > 0) {
      throw new Error(`GraphQL Errors: ${JSON.stringify(errors)}`);
    }
    return data;
  }

  // Step 1 – Begin
  async beginOrderEdit(orderId) {
    const data = await this._graphql(
      `mutation BeginOrderEdit($orderId: ID!) {
        orderEditBegin(id: $orderId) {
          calculatedOrder { id }
          userErrors { field message }
        }
      }`,
      { orderId },
    );
    return data.orderEditBegin;
  }

  // Step 2a – Add a variant
  async addVariant(calculatedOrderId, variantId, quantity, locationId = null) {
    const data = await this._graphql(
      `mutation AddVariant($id: ID!, $variantId: ID!, $quantity: Int!, $locationId: ID) {
        orderEditAddVariant(id: $id, variantId: $variantId, quantity: $quantity, locationId: $locationId) {
          calculatedOrder { id }
          userErrors { field message }
        }
      }`,
      { id: calculatedOrderId, variantId, quantity, locationId },
    );
    return data.orderEditAddVariant;
  }

  // Step 2b – Update quantity of an existing line item
  async setQuantity(calculatedOrderId, lineItemId, quantity) {
    const data = await this._graphql(
      `mutation SetQuantity($id: ID!, $lineItemId: ID!, $quantity: Int!) {
        orderEditSetQuantity(id: $id, lineItemId: $lineItemId, quantity: $quantity) {
          calculatedOrder { id }
          userErrors { field message }
        }
      }`,
      { id: calculatedOrderId, lineItemId, quantity },
    );
    return data.orderEditSetQuantity;
  }

  // Step 2c – Remove a line item
  async removeLineItem(calculatedOrderId, lineItemId) {
    return await this.setQuantity(calculatedOrderId, lineItemId, 0);
  }

  // Step 3 – Commit
  async commitOrderEdit(
    calculatedOrderId,
    notifyCustomer = false,
    staffNote = "Modified via MCP Server",
  ) {
    const data = await this._graphql(
      `mutation CommitOrderEdit($id: ID!, $notifyCustomer: Boolean, $staffNote: String) {
        orderEditCommit(id: $id, notifyCustomer: $notifyCustomer, staffNote: $staffNote) {
          order { id name totalPriceSet { shopMoney { amount currencyCode } } }
          userErrors { field message }
        }
      }`,
      { id: calculatedOrderId, notifyCustomer, staffNote },
    );
    return data.orderEditCommit;
  }

  /**
   * High-level orchestrator used by the MCP tool.
   * @param {string}   orderId   Full GID, e.g. "gid://shopify/Order/123"
   * @param {Array}    changes   Array of change descriptors (see tool schema)
   * @param {object}   options   { notifyCustomer, staffNote }
   */
  async modifyOrder(orderId, changes = [], options = {}) {
    // Step 1
    const begin = await this.beginOrderEdit(orderId);
    if (begin.userErrors?.length) {
      throw new Error(`Begin edit failed: ${begin.userErrors[0].message}`);
    }
    const calcId = begin.calculatedOrder.id;

    // Step 2 – apply each change in sequence
    for (const change of changes) {
      let result;
      if (change.type === "addVariant") {
        result = await this.addVariant(
          calcId,
          change.variantId,
          change.quantity,
          change.locationId ?? null,
        );
      } else if (change.type === "setQuantity") {
        result = await this.setQuantity(
          calcId,
          change.lineItemId,
          change.quantity,
        );
      } else if (change.type === "remove") {
        result = await this.removeLineItem(calcId, change.lineItemId);
      } else {
        throw new Error(`Unknown change type: "${change.type}"`);
      }

      if (result?.userErrors?.length) {
        throw new Error(
          `Change "${change.type}" failed: ${result.userErrors[0].message}`,
        );
      }
    }

    // Step 3
    const commit = await this.commitOrderEdit(
      calcId,
      options.notifyCustomer ?? false,
      options.staffNote ?? "Modified via MCP Server",
    );

    if (commit.userErrors?.length) {
      throw new Error(`Commit failed: ${commit.userErrors[0].message}`);
    }

    return {
      success: true,
      orderId: commit.order.id,
      orderName: commit.order.name,
      totalPrice: commit.order.totalPriceSet?.shopMoney,
      message: "Order modified successfully.",
    };
  }
}

// ********************************** MCP Tools **********************************
// ######### 1. Search Products #########
server.tool(
  "search_products",
  `Search for products based on the user's query. 
  Returns a list of products with their details, including name, price, stock status, and image URL.

  Parameters:
  @param {string} query: The search query (product name, description, etc.)
  @param {string} session_id: Session ID
  @param {string} store_code: Store name or code
  @param {boolean} full_details: 
  `,
  {
    query: z
      .string()
      .describe("Search query (product name, description, etc.)"),
    session_id: z.string().describe("Session ID"),
    store_code: z.string().describe("Store name/code"),
    full_details: z
      .boolean()
      .optional()
      .describe(
        "Whether to return full product details including variants, images, and URLs. Defaults to false.",
      ),
  },
  async ({ query, session_id, store_code, full_details = false }) => {
    try {
      const cacheKey = `search:${query}:${full_details ? "full" : "brief"}`;
      const cached = await getCache(cacheKey);
      if (cached) {
        logProductViewEvents(cached.products, session_id, store_code);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(cached, null, 2),
            },
          ],
        };
      }

      const graphqlQuery = {
        query: productSearchByQuery,
        variables: {
          search: query,
        },
      };

      // Call Shopify API to search products
      const searchResponse = await callShopifyApi("POST", "", graphqlQuery);

      // If no products found, return an error message.
      if (!searchResponse?.data?.products?.edges) {
        return {
          content: [
            {
              type: "text",
              text: "No products found for the query: ",
            },
          ],
        };
      }

      // Format the products data to be returned
      let formattedProducts = formatProducts(
        searchResponse.data.products.edges,
        session_id,
        store_code,
        full_details,
      );

      // Final response object to be returned, which may include related products if found.
      const result = {
        products: formattedProducts,
      };

      // If no products found with the initial query, try extracting keywords and searching again.
      if (result?.products?.length === 0) {
        const keywords = await extractSearchTerms(query);
        console.log(
          `No products found for this query "${query}", retrying with keywords - [${keywords}]...`,
        );

        for (let q of keywords) {
          const gQuery = {
            query: productSearchByQuery,
            variables: {
              search: q,
            },
          };

          const searchResponse = await callShopifyApi("POST", "", gQuery);

          if (
            searchResponse?.data?.products?.edges &&
            searchResponse?.data?.products?.edges?.length > 0
          ) {
            const formattedProducts = formatProducts(
              searchResponse.data.products.edges,
              session_id,
              store_code,
              full_details,
            );

            result.products = formattedProducts;
            break;
          }
        }
      }

      // Fetch related products for the found products to provide more comprehensive results.
      if (result?.products && result.products?.length > 0) {
        // Existing product IDs
        const existingProductIds = result.products.map((p) => String(p.id));

        for (let p of result.products) {
          console.log("Fetching related products for ID:", p.id);

          const relatedProducts = await fetchRelatedProducts(p.id);

          console.log(`Related products for ${p.id}:`, relatedProducts);

          if (relatedProducts && relatedProducts?.length > 0) {
            // Remove:
            // 1. duplicate IDs
            // 2. IDs already present in products
            const cleanedRelatedProducts = [
              ...new Set(
                relatedProducts.filter(
                  (id) => !existingProductIds.includes(String(id)),
                ),
              ),
            ];

            if (cleanedRelatedProducts.length > 0) {
              result.relatedProducts = cleanedRelatedProducts;
              break;
            }
          }
        }
      }

      try {
        await setCache(cacheKey, result);
      } catch (e) {
        console.warn("search cache set failed:", e?.message || e);
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error searching products: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// ######### 2. Fetch Products by IDs #########
server.tool(
  "get_products_by_ids",
  `Fetch one or more products by their Shopify product IDs.
  Returns the same shape as search_products.

  Use this when you already have product IDs (e.g. from a previous search,
  a cart payload, or user-supplied links) and need full product details.

  Parameters:
  @param {string[]} product_ids  One or more numeric or GID product IDs
  @param {string}   session_id   Session ID
  @param {string}   store_code   Store name or code
  `,
  {
    product_ids: z
      .array(z.string())
      .min(1)
      .describe(
        "One or more product IDs. Accepts plain numeric IDs ('123456789') " +
          "or full GIDs ('gid://shopify/Product/123456789').",
      ),
    session_id: z.string().describe("Session ID"),
    store_code: z.string().describe("Store name/code"),
  },
  async ({ product_ids, session_id, store_code }) => {
    try {
      // Deduplicate + normalize to full GID
      const gids = [
        ...new Set(
          product_ids.map((id) =>
            id.startsWith("gid://shopify/Product/")
              ? id
              : `gid://shopify/Product/${id}`,
          ),
        ),
      ];

      // check cache first per product id
      const numericIds = gids.map((g) =>
        g.replace("gid://shopify/Product/", ""),
      );
      const cachedProducts = [];
      const toFetch = [];

      for (const id of numericIds) {
        const cached = await getCache(`product:${id}`);
        if (cached) cachedProducts.push(cached);
        else toFetch.push(id);
      }

      const singleProductQuery = (gid) => ({
        query: productByIdQuery,
        variables: { id: gid },
      });

      // Helper to fetch a single product by GID, returning the product node or null if not found.
      const fetchOne = (gid) =>
        callShopifyApi("POST", "", singleProductQuery(gid)).then(
          (res) => res?.data?.product ?? null,
        );

      const CHUNK = 5;
      const fetchedResults = [];
      const missing = [];

      if (toFetch.length > 0) {
        // convert numeric IDs back to gids for fetchOne
        const fetchGids = toFetch.map((id) => `gid://shopify/Product/${id}`);
        for (let i = 0; i < fetchGids.length; i += CHUNK) {
          const chunk = fetchGids.slice(i, i + CHUNK);
          const settled = await Promise.allSettled(chunk.map(fetchOne));
          settled.forEach((s, idx) => {
            if (s.status === "fulfilled" && s.value)
              fetchedResults.push(s.value);
            else missing.push(chunk[idx]);
          });
        }
      }

      const formattedFetched = fetchedResults.length
        ? formatProducts(
            fetchedResults.map((node) => ({ node })),
            session_id,
            store_code,
            true,
          )
        : [];

      // cache fetched products
      for (const p of formattedFetched) {
        try {
          await setCache(`product:${p.id}`, p);
        } catch (e) {
          console.warn("product cache set failed:", e?.message || e);
        }
      }

      const formattedProducts = [...cachedProducts, ...formattedFetched];

      if (formattedProducts.length === 0) {
        return {
          content: [
            { type: "text", text: "No products found for the provided IDs." },
          ],
        };
      }

      logProductViewEvents(formattedProducts, session_id, store_code);

      const responsePayload = {
        products: formattedProducts,
        ...(missing.length > 0 && { missing_ids: missing }),
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(responsePayload, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error fetching products by ID: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// ######### 3. Fetch Sorted Products #########
server.tool(
  "get_products_sorted",
  `Fetch up to 5 products, sorted by Shopify sort options. Supported sort keys: relevance, price_asc, price_desc, newest, best_selling.

  Parameters:
  @param {string} session_id: Session ID
  @param {string} store_code: Store name or code
  @param {string} [sort_key]: Sort key. Supported values: relevance, price_asc, price_desc, newest, best_selling, featured.
  `,
  {
    session_id: z.string().describe("Session ID"),
    store_code: z.string().describe("Store name/code"),
    sort_key: z.string().describe("Sort key for the product list"),
  },
  async ({ session_id, store_code, sort_key }) => {
    try {
      const cacheKey = `get_products_sorted:${String(sort_key || "relevance")}`;
      const cached = await getCache(cacheKey);
      if (cached) {
        logProductViewEvents(cached.products, session_id, store_code);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(cached, null, 2),
            },
          ],
        };
      }

      const { sortKey, reverse } = getProductSortConfig(sort_key);

      const graphqlQuery = {
        query: productSortQuery,
        variables: {
          sortKey,
          reverse,
        },
      };

      const response = await callShopifyApi("POST", "", graphqlQuery);

      const products = response?.data?.products?.edges || [];

      const formattedProducts = formatProducts(
        products,
        session_id,
        store_code,
        false,
      );

      const result = { products: formattedProducts };
      try {
        await setCache(cacheKey, result);
      } catch (cacheError) {
        console.warn(
          "get_products_sorted cache set failed:",
          cacheError?.message || cacheError,
        );
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error fetching sorted products: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// ######### 4. Fetch Store Metadata #########
server.tool(
  "get_store_meta_info",
  `Fetch metadata about the store's product catalog.
  Returns product tags, types, collections, and categories available in the store.
  `,
  async () => {
    try {
      const metadata = await storeMetadata();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(metadata, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error fetching store metadata: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// ######### 5. Filter Products by Space #########
server.tool(
  "filter_products_by_space",
  `Filters and ranks products based on available space by extracting dimensions from product descriptions.
   Returns products in the same format as search_products.`,
  {
    products: z.array(
      z.object({
        id: z.string().optional(),
        title: z.string().optional(),
        description: z.string().optional(),
        tags: z.string().optional(),
        productType: z.string().optional(),
        availableForSale: z.boolean().optional(),
        onlineStoreUrl: z.string().optional(),
        priceRange: z.any().optional(),
        variants: z.any().optional(),
        images: z.any().optional(),
      }),
    ),
    space: z.object({
      width: z.number(),
      length: z.number(),
      unit: z.string().describe("cm | m | ft | inch"),
    }),
  },

  async ({ products, space }) => {
    try {
      // Parse and validate space input
      const parsedSpace = parseSpaceInput(space);

      if (!parsedSpace) {
        console.warn(
          "filter_products_by_space called with invalid space:",
          space,
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ products: products.slice(0, 5) }, null, 2),
            },
          ],
        };
      }

      const { widthCm: spaceWidthCm, lengthCm: spaceLengthCm } = parsedSpace;

      // Process each product
      const scoredProducts = [];

      for (const product of products) {
        const desc = product.description || "";

        // Extract and normalize dimensions from description
        let dims = extractDimensions(desc);
        dims = normalizeDims(dims);

        let fitType = "near";

        if (dims) {
          // Check if product fits (with rotation support)
          const fits =
            (dims.length <= spaceLengthCm && dims.width <= spaceWidthCm) ||
            (dims.width <= spaceLengthCm && dims.length <= spaceWidthCm);

          // Check if product fits within tolerance (~30%)
          const toleranceFits =
            (dims.length <= spaceLengthCm * 1.3 &&
              dims.width <= spaceWidthCm * 1.3) ||
            (dims.width <= spaceLengthCm * 1.3 &&
              dims.length <= spaceWidthCm * 1.3);

          if (fits) fitType = "fit";
          else if (toleranceFits) fitType = "near";
          else fitType = "oversized";
        }

        const score = getRelevanceScore(product, dims);

        scoredProducts.push({
          product,
          score,
          fitType,
        });
      }

      // Sort products by fit quality, then by relevance score
      const sortedProducts = scoredProducts
        .sort((a, b) => {
          const fitPriority = { fit: 3, near: 2, oversized: 1 };

          if (fitPriority[b.fitType] !== fitPriority[a.fitType]) {
            return fitPriority[b.fitType] - fitPriority[a.fitType];
          }

          return b.score - a.score;
        })
        .map((p) => p.product);

      // Return top 5 products (or fallback to top 3 if none passed filters)
      let finalProducts = sortedProducts.slice(0, 5);

      if (finalProducts.length === 0) {
        finalProducts = products.slice(0, 3);
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ products: finalProducts }, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error filtering products: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// ######### 6. List Available Discounts #########
server.tool(
  "list_available_discounts",
  `List all available discounts from the store.
  Returns active discount codes, automatic discounts (price rules), and their details.
  `,
  {},
  async () => {
    try {
      const cacheKey = "available_discounts";
      const cached = await getCache(cacheKey);
      if (cached) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(cached, null, 2),
            },
          ],
        };
      }

      const graphqlQuery = {
        query: discountQuery,
      };

      const response = await callShopifyApi("POST", "", graphqlQuery, true);

      if (
        !response?.data?.discountNodes?.edges ||
        response?.data?.discountNodes?.edges?.length < 1
      ) {
        return {
          content: [
            {
              type: "text",
              text: "No discounts found.",
            },
          ],
        };
      }

      const discounts = formatDiscounts(response?.data?.discountNodes?.edges);

      if (discounts.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No discounts found.",
            },
          ],
        };
      }

      // Sort by end date (active first)
      discounts.sort((a, b) => new Date(b.ends_at) - new Date(a.ends_at));

      const payload = {
        total: discounts.length,
        discounts: discounts,
      };

      try {
        await setCache(cacheKey, payload);
      } catch (cacheError) {
        console.warn(
          "available_discounts cache set failed:",
          cacheError?.message || cacheError,
        );
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(payload, null, 2),
          },
        ],
      };
    } catch (error) {
      console.error("Error fetching discounts:", error);
      return {
        content: [
          {
            type: "text",
            text: `Error fetching available discounts: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// ######### 7. Send OTP #########
server.tool(
  "send_otp",
  `Send a verification OTP to the provided email.
  This tool is strictly used for order tracking verification.

  Parameters:
  @param {string} email - User email to receive OTP
  @param {string} session_id - Unique session identifier
  `,
  {
    email: z.string().email().describe("User email address"),
    session_id: z.string().min(5).describe("Unique session identifier"),
  },
  async ({ email, session_id }) => {
    try {
      const verificationStatus = await callBackendAPI(
        "POST",
        "/chat/email/verify-status/",
        { thread_id: session_id, email: email },
      );
      if (verificationStatus && verificationStatus?.is_verified) {
        return {
          content: [{ type: "text", text: "Your email is already verified." }],
          isError: false,
        };
      }

      // Check customer existence (Admin API only)
      const customerResponse = await callShopifyApi(
        "GET",
        `/admin/api/2024-01/customers/search.json?query=email:${encodeURIComponent(email)}`,
      );

      // Prevent email enumeration
      if (
        !customerResponse?.customers?.length ||
        customerResponse?.customers?.length === 0
      ) {
        return {
          content: [
            {
              type: "text",
              text: "No account found with this email.",
            },
          ],
        };
      }

      const otpResponse = await callBackendAPI("POST", "/chat/otp/generate/", {
        thread_id: session_id,
        email: email,
      });

      if (!otpResponse || !otpResponse?.otp) {
        return {
          content: [
            { type: "text", text: "Failed to send otp, please try again." },
          ],
          isError: true,
        };
      }

      // Send email
      await transporter.sendMail({
        from: `"Shopify Support" <${process.env.SMTP_USER}>`,
        to: email,
        subject: "Your verification code",
        text: `Your verification code is ${otpResponse?.otp}. It will expire in ${otpResponse?.expires_in_seconds} seconds.`,
      });

      return {
        content: [
          {
            type: "text",
            text:
              // "If an account exists with this email, a verification code has been sent.",
              "A 6-digit verification code has been sent to your email.",
          },
        ],
      };
    } catch (error) {
      console.error("Send OTP error:", error);
      return {
        content: [
          { type: "text", text: "Unable to send verification code right now." },
        ],
        isError: true,
      };
    }
  },
);

// ######### 8. Verify OTP #########
server.tool(
  "verify_otp",
  `Verify an OTP sent for order tracking email verification.

  Parameters:
  @param {string} email - User email used for verification
  @param {string} otp_code - 6 digit OTP
  @param {string} session_id - Session identifier
  `,
  {
    email: z.string().email().describe("User email"),
    otp_code: z.string().length(6).describe("6 digit OTP"),
    session_id: z.string().describe("Session identifier"),
  },
  async ({ email, otp_code, session_id }) => {
    try {
      const payload = {
        thread_id: session_id,
        email: email,
        otp: otp_code,
      };
      const verificationResponse = await callBackendAPI(
        "POST",
        "/chat/otp/verify/",
        payload,
      );

      if (!verificationResponse || !verificationResponse?.is_verified) {
        return {
          content: [
            { type: "text", text: "Invalid or expired verification code." },
          ],
          isError: true,
        };
      }

      return {
        content: [{ type: "text", text: "Verification successful." }],
        verified: true,
      };
    } catch (error) {
      console.error("Verify OTP error:", error);
      return {
        content: [
          { type: "text", text: "Verification failed. Please try again." },
        ],
        isError: true,
      };
    }
  },
);

// ######### 9. Get Order Detail #########
server.tool(
  "get_order_detail",
  `Fetch a specific order by order number and email.
  Returns a single order object.

  Parameters:
  @param {string} email: Order identifier (e.g. "test@example.com")
  @param {string} order_id: Order identifier (e.g. "1026")
  @param {string} session_id - Session identifier
  @param {string} customer_id - Customer ID
  `,
  {
    email: z.string().describe("Order email (e.g. 'test@example.com')"),
    order_id: z.string().describe("Order ID (e.g. '1026')"),
    session_id: z.string().describe("Session identifier"),
    customer_id: z.string().describe("Customer ID"),
  },
  async ({ email, order_id, session_id, customer_id = "" }) => {
    if (!customer_id) {
      const verificationStatus = await callBackendAPI(
        "POST",
        "/chat/email/verify-status/",
        { thread_id: session_id, email: email },
      );

      if (!verificationStatus && !verificationStatus?.is_verified) {
        return {
          content: [
            {
              type: "text",
              text: "Please verify your email before accessing order details.",
            },
          ],
          isError: true,
        };
      }
    }

    try {
      const response = await callShopifyApi(
        "GET",
        `/admin/api/2024-04/orders.json?email=${encodeURIComponent(email)}&status=any`,
      );

      // No orders
      if (!response || !Array.isArray(response.orders)) {
        return {
          content: [
            {
              type: "text",
              text: "We couldn’t found your order with this email.",
            },
          ],
          isError: true,
        };
      }

      const orders = response?.orders;

      const currentOrder = orders.find((o) => o?.order_number == order_id);

      if (!currentOrder) {
        return {
          content: [
            {
              type: "text",
              text: `We couldn’t locate order #${order_id}. Please verify the order ID and try again.`,
            },
          ],
          isError: true,
        };
      }

      const formattedOrder = formatOrder(currentOrder);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(formattedOrder, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error fetching order detail: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// ######### 10. Create Support Ticket #########
server.tool(
  "create_support_ticket",
  `Create a support ticket for a customer issue.

  Behavior:
  1. Check if requester exists by email.
  2. If not found, create new user.
  3. Create support ticket linked to requester.
  4. Return ticket ID in response.

  Parameters:
  - email (string): Customer email address
  - subject (string): Ticket subject line
  - description (string): Detailed problem description
  - session_id (string): Session ID
  - store_code (string): Store Code
  `,
  {
    email: z.string().email().describe("Customer email address"),
    subject: z.string().min(3).describe("Short ticket subject"),
    description: z.string().min(5).describe("Detailed issue description"),
    session_id: z.string().describe("Session ID"),
    store_code: z.string().describe("Store Code"),
  },
  async ({ email, subject, description, session_id, store_code }) => {
    try {
      const authConfig = {
        auth: {
          username: `${ZENDESK_USERNAME}/token`,
          password: ZENDESK_PASSWORD,
        },
        headers: {
          "Content-Type": "application/json",
        },
      };

      let requesterId = null;

      // Search existing user
      const searchResponse = await axios.get(
        `${ZENDESK_API_URL}/users/search.json?query=${encodeURIComponent(email)}`,
        authConfig,
      );

      if (searchResponse?.data?.users?.length > 0) {
        requesterId = searchResponse.data.users[0].id;
      }

      // Create user if not found
      if (!requesterId) {
        const userResponse = await axios.post(
          `${ZENDESK_API_URL}/users.json`,
          {
            user: {
              name: email.split("@")[0],
              email: email,
            },
          },
          authConfig,
        );

        requesterId = userResponse?.data?.user?.id;
      }

      if (!requesterId) {
        return {
          content: [{ type: "text", text: "Unable to create requester user." }],
          isError: true,
        };
      }

      // Create ticket
      const ticketResponse = await axios.post(
        `${ZENDESK_API_URL}/tickets.json`,
        {
          ticket: {
            subject: subject,
            comment: {
              body: description,
            },
            requester_id: requesterId,
            priority: "normal",
          },
        },
        authConfig,
      );

      const ticketId = ticketResponse?.data?.ticket?.id;

      if (!ticketId) {
        return {
          content: [{ type: "text", text: "Failed to create support ticket." }],
          isError: true,
        };
      }

      const payload = {
        requester_id: requesterId,
        subject: subject,
        description: description,
        thread_id: session_id,
        store_code: store_code,
        ticket_id: ticketId,
      };

      callBackendAPI("POST", `/support/tickets/`, payload);

      // Success Response
      return {
        content: [
          {
            type: "text",
            text: `Support ticket #${ticketId} created successfully. Our team will contact you soon.`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error creating support ticket: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// ######### 11. Modify Order #########
server.tool(
  "modify_order",
  `Modify an existing Shopify order using the 3-step Order Edit API
  (orderEditBegin → apply changes → orderEditCommit).

  Supported change types in the "changes" array:
    • addVariant   – add a product variant to the order
    • setQuantity  – update the quantity of an existing line item
    • remove       – remove a line item from the order

  Parameters:
  @param {string}  order_id         Shopify Order GID or plain numeric ID (e.g. "123456789")
  @param {array}   changes          List of change objects (see schema below)
  @param {boolean} notify_customer  Whether to send a notification email to the customer (default: false)
  @param {string}  staff_note       Internal note attached to the edit (default: "Modified via MCP Server")
  `,
  {
    order_id: z
      .string()
      .describe(
        "Shopify Order ID. Accepts plain numeric ID ('123456') " +
          "or full GID ('gid://shopify/Order/123456').",
      ),
    changes: z
      .array(
        z.discriminatedUnion("type", [
          // Add a new variant
          z.object({
            type: z.literal("addVariant"),
            variantId: z
              .string()
              .describe(
                "Variant GID or numeric ID to add, e.g. 'gid://shopify/ProductVariant/987'",
              ),
            quantity: z.number().int().positive().describe("Quantity to add"),
            locationId: z
              .string()
              .optional()
              .describe("Optional inventory location GID"),
          }),
          // Update quantity of an existing line item
          z.object({
            type: z.literal("setQuantity"),
            lineItemId: z
              .string()
              .describe(
                "CalculatedLineItem GID, e.g. 'gid://shopify/CalculatedLineItem/456'",
              ),
            quantity: z
              .number()
              .int()
              .nonnegative()
              .describe("New quantity (0 = remove)"),
          }),
          // Remove a line item
          z.object({
            type: z.literal("remove"),
            lineItemId: z
              .string()
              .describe(
                "CalculatedLineItem GID to remove, e.g. 'gid://shopify/CalculatedLineItem/456'",
              ),
          }),
        ]),
      )
      .min(1)
      .describe("One or more changes to apply to the order."),
    notify_customer: z
      .boolean()
      .optional()
      .describe(
        "Send a notification email to the customer after the edit. Defaults to false.",
      ),
    staff_note: z
      .string()
      .optional()
      .describe(
        "Internal staff note for the edit. Defaults to 'Modified via MCP Server'.",
      ),
  },
  async ({ order_id, changes, notify_customer = false, staff_note }) => {
    try {
      // Normalise to full GID
      const orderId = order_id.startsWith("gid://shopify/Order/")
        ? order_id
        : `gid://shopify/Order/${order_id}`;

      // Normalise variant / lineItem IDs inside changes
      const normalisedChanges = changes.map((c) => {
        if (c.type === "addVariant") {
          return {
            ...c,
            variantId: c.variantId.startsWith("gid://shopify/ProductVariant/")
              ? c.variantId
              : `gid://shopify/ProductVariant/${c.variantId}`,
          };
        }
        if (c.type === "setQuantity" || c.type === "remove") {
          return {
            ...c,
            lineItemId: c.lineItemId.startsWith(
              "gid://shopify/CalculatedLineItem/",
            )
              ? c.lineItemId
              : `gid://shopify/CalculatedLineItem/${c.lineItemId}`,
          };
        }
        return c;
      });

      const editor = new ShopifyOrderEditor();
      const result = await editor.modifyOrder(orderId, normalisedChanges, {
        notifyCustomer: notify_customer,
        staffNote: staff_note,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      console.error("modify_order error:", error);
      return {
        content: [
          {
            type: "text",
            text: `Error modifying order: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// ######### 12. Cancel Order #########
server.tool(
  "cancel_order",
  `Cancel a Shopify order by order number.

  Parameters:
  @param {string} order_id - Order number (e.g. "1006")
  @param {string} email - Customer email
  @param {string} reason - Cancellation reason
  @param {string} session_id - Session identifier
  `,
  {
    order_id: z.string().describe("Order number"),
    email: z.string().email().describe("Customer email"),
    reason: z.string().describe("Cancellation reason"),
    session_id: z.string().describe("Session identifier"),
  },
async ({ order_id, email, reason, session_id }) => {
    try {
      const response = await callShopifyApi(
        "GET",
        `/admin/api/2024-04/orders.json?name=%23${order_id}&status=any`,
      );

      const orders = response?.orders || [];
      if (!orders.length) {
        return {
          content: [{ type: "text", text: `Order #${order_id} not found.` }],
          isError: true,
        };
      }

      const order = orders[0];

      // inline cancellability check — no imported function needed
      if (order.cancelled_at) {
        return { content: [{ type: "text", text: "Order already cancelled." }], isError: true };
      }
      const fulfillment = (order.fulfillment_status || "").toLowerCase();
      if (["fulfilled", "shipped"].includes(fulfillment)) {
        return { content: [{ type: "text", text: "Order already shipped and cannot be cancelled." }], isError: true };
      }
      const financial = (order.financial_status || "").toLowerCase();
      if (["refunded", "voided"].includes(financial)) {
        return { content: [{ type: "text", text: "Order already refunded." }], isError: true };
      }

      const cancelResponse = await callShopifyApi(
        "POST",
        `/admin/api/2024-04/orders/${order.id}/cancel.json`,
        { reason: reason, email: true },
      );

      if (!cancelResponse?.order) {
        return {
          content: [{ type: "text", text: "Failed to cancel the order." }],
          isError: true,
        };
      }

      const cancelled = cancelResponse.order;

      console.log(
        `cancel_order: success | order_id=${cancelled.order_number} | email=${email} | session=${session_id} | reason=${reason}`
      );


      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              order_id: cancelled.order_number,
              cancelled_at: cancelled.cancelled_at,
              cancel_reason: cancelled.cancel_reason,
              financial_status: cancelled.financial_status,
              message: `Order #${order_id} has been successfully cancelled.`,
            }),
          },
        ],
      };
    } catch (error) {
      console.error("cancel_order error:", error.message);
      return {
        content: [{ type: "text", text: `Error cancelling order: ${error.message}` }],
        isError: true,
      };
    }
  },
);
// ********************************** End of MCP Tools **********************************

// Start the server
const app = express();
app.use(express.json());

// Enable CORS for all routes and origins to allow cross-origin requests from any client, which is essential for the MCP server to be accessible from different domains and frontend applications without CORS issues.
app.use(
  cors({
    origin: "*",
    methods: ["POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  }),
);

// Handle incoming MCP requests at the /mcp endpoint, connecting them to the MCP server transport layer. This allows the server to process JSON-RPC requests sent to /mcp and route them to the appropriate tools defined in the MCP server.
app.post("/mcp", async (req, res) => {
  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      console.log("Request closed");
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("Error handling MCP request:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal server error",
        },
        id: null,
      });
    }
  }
});

// Explicitly disallow GET and DELETE methods on the /mcp endpoint to ensure that only POST requests are accepted, which is important for maintaining the integrity of the MCP server's JSON-RPC communication and preventing unintended access or operations through unsupported HTTP methods.
app.get("/mcp", async (req, res) => {
  console.log("Received GET MCP request");
  res.writeHead(405).end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Method not allowed.",
      },
      id: null,
    }),
  );
});
app.delete("/mcp", async (req, res) => {
  console.log("Received DELETE MCP request");
  res.writeHead(405).end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Method not allowed.",
      },
      id: null,
    }),
  );
});

// Start the Express server on the specified port, and log a message indicating that the MCP Stateless Streamable HTTP Server is listening. If there is an error during startup, it will be logged and the process will exit with a failure code.
const PORT = process.env.PORT || 3000;
app.listen(PORT, (error) => {
  if (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
  console.log(`MCP Stateless Streamable HTTP Server listening on port ${PORT}`);
});
