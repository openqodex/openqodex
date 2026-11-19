from fastapi import FastAPI

from .deps import get_db
from .shim import Depends

other = FastAPI()


@other.get("/x")
def x(db=Depends(get_db)):
    return db
