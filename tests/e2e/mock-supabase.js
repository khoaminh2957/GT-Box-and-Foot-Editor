// Stands in for supabase-js in the browser tests: same call shapes (auth.getSession, auth.signInAnonymously, rpc, from().select().eq().order().limit(), maybeSingle),
// but every call goes to the mock backend of mock-server.mjs with this browser's anonymous uid.
(function () {
  const post = async (path, body) => {
    const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", "x-uid": localStorage.getItem("gt_mock_uid") || "" }, body: JSON.stringify(body) });
    return r.json();
  };
  function builder(table) {
    const q = { table, filters: {}, single: false };
    const b = {
      select() { return b; },
      eq(k, v) { q.filters[k] = v; return b; },
      order() { return b; }, limit() { return b; },
      maybeSingle() { q.single = true; return b; },
      then(resolve, reject) { return post("/__mock/query", q).then(resolve, reject); },
    };
    return b;
  }
  window.supabase = {
    createClient() {
      return {
        auth: {
          async getSession() { const u = localStorage.getItem("gt_mock_uid"); return { data: { session: u ? { user: { id: u } } : null }, error: null }; },
          async signInAnonymously() { const u = crypto.randomUUID(); localStorage.setItem("gt_mock_uid", u); return { data: { user: { id: u } }, error: null }; },
        },
        rpc: (fn, args) => post("/__mock/rpc", { fn, args }),
        from: builder,
      };
    },
  };
})();
