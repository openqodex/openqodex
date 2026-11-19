---
"openqodex": minor
---

The code graph now finds callers that Python code reaches through fields and FastAPI dependencies. A field a method assigns from an annotated parameter (`def __init__(self, store: Store)` then `self.store = store`) takes that type, so `self.store.get(id)` is a certain caller of `Store.get`, and a chain such as `self.client.http.send()` is followed one field at a time. A field assigned two different types is no longer a certain caller of either. A FastAPI `Depends(get_db)` or `Security(auth)`, in a parameter, in `Annotated[...]`, on the decorator, on a router or on the application, is now a certain call from each route it runs for, with evidence `fastapi-depends`, so `graph callers get_db` lists every route that depends on it instead of nothing. A dependency that itself depends on another is a call from the first to the second. `graph routes` lists each route's dependencies in the order they run.
