const axios = require('axios');
const dotenv = require('dotenv');
dotenv.config();

const shopDomain = process.env.SHOPIFY_BASE_URL.replace(/^https?:\/\//, "").replace(/\/$/, "");
const apiVersion = process.env.SHOPIFY_API_VERSION || "2025-04";

async function check() {
  const q = `
  {
    __type(name: "ReturnProcessInput") {
      inputFields {
        name
        type { name kind }
      }
    }
  }`;
  const res = await axios.post(
    `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`,
    { query: q },
    { headers: { "X-Shopify-Access-Token": process.env.SHOPIFY_ACCESS_TOKEN, "Content-Type": "application/json" } }
  );
  console.log(JSON.stringify(res.data, null, 2));
}
check();
