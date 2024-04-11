const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

// Initialize Supabase client
const USE_TEST_SUPABASE = process.env.USE_TEST_SUPABASE === "true";
const supabaseUrl = USE_TEST_SUPABASE
  ? process.env.VITE_SUPABASE_TEST_URL
  : process.env.VITE_SUPABASE_URL;
const supabaseKey = USE_TEST_SUPABASE
  ? process.env.VITE_SUPABASE_TEST_ANON_KEY
  : process.env.VITE_SUPABASE_ANON_KEY;

console.log("supabase: ", supabaseUrl, supabaseKey);

const supabase = createClient(supabaseUrl, supabaseKey);

/**
 * Function to fetch data from a given table in Supabase.
 * @param {String} tableName - The name of the table to fetch data from.
 * @returns {Promise<Array>} - A promise that resolves to the data fetched.
 */
async function fetchData(
  tableName,
  { filters = {}, sort = null, page = 1, limit = 10 }
) {
  let query = supabase.from(tableName).select("*");

  // Apply filters
  Object.keys(filters).forEach((key) => {
    query = query.eq(key, filters[key]);
  });

  // Apply sorting
  if (sort) {
    query = query.order(sort.column, { ascending: sort.ascending });
  }

  // Apply pagination
  query = query.range((page - 1) * limit, page * limit - 1);

  const { data, error } = await query;

  if (error) {
    console.error("Error fetching data:", error);
    return [];
  }

  return data;
}
/**
 * Function to insert data into a given table in Supabase.
 * @param {String} tableName - The name of the table to insert data into.
 * @param {Object} data - The data to insert.
 * @returns {Promise<Object>} - A promise that resolves to the inserted data.
 */
async function insertData(tableName, data) {
  const { data: insertedData, error } = await supabase
    .from(tableName)
    .insert([data]);

  if (error) {
    console.error("Error inserting data:", error);
    return null;
  }

  return insertedData;
}

module.exports = { fetchData, insertData, supabase };
