// Query to search products by a free-text `search` string, which may also
// contain field-qualified clauses (product_type:, vendor:, tag:,
// variants.price, available_for_sale:) built by buildShopifySearchQuery.
// - Variables: { search: String!, sortKey, reverse, first: Int! }
// - Returns: up to `first` matching products with selected fields, including
//   images, price range, and up to 20 variants per product.
//   The `first` value is passed dynamically from the search_products tool
//   in server.js (default: 15) — giving the calling agent's own
//   audience/budget/attribute post-filtering enough surviving candidates.
const productSearchByQuery = `query getProducts($search: String!, $sortKey: ProductSortKeys!, $reverse: Boolean!, $first: Int!) {
  products(first: $first, query: $search, sortKey:$sortKey, reverse:$reverse) {
    edges {
      node {
        id
        title
        handle
        productType
        category {
          name
        }
        availableForSale
        onlineStoreUrl
        description
        descriptionHtml

        metafield(namespace: "custom", key: "warranty") {
          value
          type
        }

        images(first: 5) {
          edges {
            node {
              url
              altText
            }
          }
        }

        priceRange {
          minVariantPrice {
            amount
            currencyCode
          }
        }

        variants(first: 20) {
          edges {
            node {
              id
              title
              priceV2 {
                amount
                currencyCode
              }
              compareAtPriceV2 {
                amount
                currencyCode
              }
              availableForSale
              quantityAvailable
              currentlyNotInStock
              selectedOptions {
                name
                value
              }
            }
          }
        }
      }
    }
  }
}`;

// GraphQL query to fetch store metadata including product tags, types, collections, and categories.
const storeMetadataQuery = `query {
    productTags(first: 250) {
        edges {
        node
        }
    }

    productTypes(first: 250) {
        edges {
        node
        }
    }

    collections(first: 250) {
        edges {
        node {
            title
        }
        }
    }

    products(first: 250) {
        edges {
        node {
            category {
            name
            }
        }
        }
    }
}`;

// GraphQL query to fetch related products based on a given product ID.
const relatedProductsQuery = `query getRecommendations($productId: ID!) {
    productRecommendations(productId: $productId) {
        id
    }
}`;

// GraphQL query to fetch a single product by its ID, including detailed information such as images, price range, and variants.
const productByIdQuery = `query getProductById($id: ID!) {
    product(id: $id) {
        id title handle productType category { name } availableForSale onlineStoreUrl
        description descriptionHtml
        metafield(namespace: "custom", key: "warranty") {
          value
          type
        }
        images(first: 5) { edges { node { url altText } } }
        priceRange { minVariantPrice { amount currencyCode } }
        variants(first: 20) {
            edges {
            node {
                    id title
                    priceV2 { amount currencyCode }
                    compareAtPriceV2 { amount currencyCode }
                    availableForSale quantityAvailable currentlyNotInStock
                    selectedOptions { name value }
                }
            }
        }
    }
}`;

// ---------------------------------------------------------------------------
// Queries backing get_filter_options.
//
// Collection membership is NOT expressible in the Storefront `products(query:)`
// search syntax (it only supports product_type, tag, title, vendor, variants.price
// and a few others - a `collection:"X"` clause is silently treated as free text).
// So anything collection-scoped has to go through the `collection(handle:)` root
// field instead, which is what these queries do.
// ---------------------------------------------------------------------------

// Collection titles paired with the handles needed to address them.
const collectionsListQuery = `query {
    collections(first: 250) {
        edges {
        node {
            id
            title
            handle
        }
        }
    }
}`;

// Admin-API variant of the collections list, adding the real product count per
// collection in ONE call. The Storefront API exposes no count at all, so
// ranking there would mean paging every collection's products just to size it.
// Falls back to `collectionsListQuery` when the admin scope isn't granted.
const collectionsWithCountsQuery = `query {
    collections(first: 250) {
        edges {
        node {
            id
            title
            handle
            productsCount {
                count
            }
        }
        }
    }
}`;

// Lightweight facet scan of one collection: only the fields needed to rank
// categories by real product count and compute true price bounds. Deliberately
// omits images/variants/descriptions so a few hundred products stay cheap.
const collectionFacetsQuery = `query getCollectionFacets($handle: String!, $first: Int!, $after: String, $filters: [ProductFilter!]) {
    collection(handle: $handle) {
        id
        title
        handle
        products(first: $first, after: $after, filters: $filters) {
            pageInfo { hasNextPage endCursor }
            edges {
            node {
                id
                title
                productType
                category { name }
                availableForSale
                priceRange {
                    minVariantPrice { amount currencyCode }
                    maxVariantPrice { amount currencyCode }
                }
            }
            }
        }
    }
}`;

// Same lightweight shape, but store-wide via the normal product search - used
// when no collection is in play.
const productFacetsQuery = `query getProductFacets($search: String, $first: Int!, $after: String) {
    products(first: $first, query: $search, after: $after) {
        pageInfo { hasNextPage endCursor }
        edges {
        node {
            id
            title
            productType
            category { name }
            availableForSale
            priceRange {
                minVariantPrice { amount currencyCode }
                maxVariantPrice { amount currencyCode }
            }
        }
        }
    }
}`;

// Batch hydrate of full product details for a set of IDs, so the facet scan can
// stay lightweight and only the handful of products actually being shown get the
// expensive fields. Same selection set as productByIdQuery, so the result feeds
// straight into formatProducts.
const productsByIdsQuery = `query getProductsByIds($ids: [ID!]!) {
    nodes(ids: $ids) {
        ... on Product {
            id title handle productType category { name } availableForSale onlineStoreUrl
            description descriptionHtml
            metafield(namespace: "custom", key: "warranty") {
              value
              type
            }
            images(first: 5) { edges { node { url altText } } }
            priceRange { minVariantPrice { amount currencyCode } }
            variants(first: 20) {
                edges {
                node {
                        id title
                        priceV2 { amount currencyCode }
                        compareAtPriceV2 { amount currencyCode }
                        availableForSale quantityAvailable currentlyNotInStock
                        selectedOptions { name value }
                    }
                }
            }
        }
    }
}`;

// GraphQL query to fetch products sorted by specified Shopify sort options, such as relevance, price ascending/descending, newest, or best selling.
const productSortQuery = `query getProducts(
  $search: String
  $sortKey: ProductSortKeys
  $reverse: Boolean
  $first: Int!
) {
  products(
    first: $first
    query: $search
    sortKey: $sortKey
    reverse: $reverse
  ) {
    edges {
      node {
        id
        title
        category {
          name
        }
        priceRange {
          minVariantPrice {
            amount
            currencyCode
          }
        }
        description
        metafield(namespace: "custom", key: "warranty") {
          value
          type
        }
        availableForSale
        variants(first: 20) {
          edges {
          node {
              priceV2 { amount currencyCode }
              compareAtPriceV2 { amount currencyCode }
              availableForSale
            }
          }
        }
      }
    }
  }
}`;

const discountQuery = `{
  discountNodes(first: 20) {
    edges {
      node {
        id
        discount {
          __typename

          ... on DiscountAutomaticBasic {
            title
            startsAt
            endsAt

            customerGets {
              value {
                __typename

                ... on DiscountPercentage {
                  percentage
                }

                ... on DiscountAmount {
                  amount {
                    amount
                    currencyCode
                  }
                }
              }

              items {
                __typename

                ... on AllDiscountItems {
                  allItems
                }

                ... on DiscountProducts {
                  products(first: 10) {
                    edges {
                      node {
                        id
                        title
                      }
                    }
                  }
                }

                ... on DiscountCollections {
                  collections(first: 10) {
                    edges {
                      node {
                        id
                        title
                      }
                    }
                  }
                }
              }
            }
          }

          ... on DiscountCodeBasic {
            title
            startsAt
            endsAt

            codes(first: 5) {
              edges {
                node {
                  code
                }
              }
            }

            customerGets {
              value {
                __typename

                ... on DiscountPercentage {
                  percentage
                }

                ... on DiscountAmount {
                  amount {
                    amount
                    currencyCode
                  }
                }
              }

              items {
                __typename

                ... on AllDiscountItems {
                  allItems
                }

                ... on DiscountProducts {
                  products(first: 10) {
                    edges {
                      node {
                        id
                        title
                      }
                    }
                  }
                }

                ... on DiscountCollections {
                  collections(first: 10) {
                    edges {
                      node {
                        id
                        title
                      }
                    }
                  }
                }
              }
            }
          }

          ... on DiscountAutomaticBxgy {
            title
            startsAt
            endsAt

            customerGets {
              value {
                __typename

                ... on DiscountPercentage {
                  percentage
                }

                ... on DiscountAmount {
                  amount {
                    amount
                    currencyCode
                  }
                }
              }

              items {
                __typename

                ... on DiscountProducts {
                  products(first: 10) {
                    edges {
                      node {
                        id
                        title
                      }
                    }
                  }
                }

                ... on DiscountCollections {
                  collections(first: 10) {
                    edges {
                      node {
                        id
                        title
                      }
                    }
                  }
                }
              }
            }

            customerBuys {
              value {
                ... on DiscountQuantity {
                  quantity
                }
              }
            }
          }

          ... on DiscountAutomaticFreeShipping {
            title
            startsAt
            endsAt
          }
        }
      }
    }
  }
}`;
const getReturnableFulfillmentsQuery = `
  query GetReturnableFulfillments($orderId: ID!) {
    returnableFulfillments(orderId: $orderId, first: 10) {
      edges {
        node {
          id
          fulfillment { id }
          returnableFulfillmentLineItems(first: 10) {
            edges {
              node {
                fulfillmentLineItem {
                  id
                  lineItem { id }
                }
                quantity
              }
            }
          }
        }
      }
    }
  }
`;

const refundQuery = `
  query GetOrderRefundStatus($id: ID!) {
    order(id: $id) {
      id
      name
      displayFinancialStatus
      refundable
      refunds(first: 20) {
        id
        createdAt
      }
      transactions(first: 20) {
        id
        kind
        status
      }
    }
  }
`;

// Export the GraphQL query for use in other modules
module.exports = {
  productSearchByQuery,
  storeMetadataQuery,
  relatedProductsQuery,
  productByIdQuery,
  collectionsListQuery,
  collectionsWithCountsQuery,
  collectionFacetsQuery,
  productFacetsQuery,
  productsByIdsQuery,
  productSortQuery,
  discountQuery,
  refundQuery,
  getReturnableFulfillmentsQuery,
};
