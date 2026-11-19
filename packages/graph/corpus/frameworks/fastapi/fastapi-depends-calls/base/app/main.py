from typing import Annotated

from fastapi import APIRouter, Depends, FastAPI, Query, Security

from .deps import audit, auth_user, get_current_user, get_db

app = FastAPI(dependencies=[Depends(audit)])
router = APIRouter(prefix="/items", dependencies=[Depends(auth_user)])


@router.get("/{item_id}")
def read_item(item_id: int, db=Depends(get_db), q: str = Query(None)):
    return db


@router.get("/me")
def me(user: Annotated[str, Depends(get_current_user)]):
    return user


@app.get("/secure")
def secure(user=Security(get_current_user)):
    return user


app.include_router(router)
