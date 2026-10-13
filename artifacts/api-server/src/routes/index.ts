import { Router, type IRouter } from "express";
import healthRouter from "./health";
import gmgnRouter from "./gmgn";

const router: IRouter = Router();
export const GMGN_BASE_ROUTE = "/gmgn";

router.use(healthRouter);
router.use(GMGN_BASE_ROUTE, gmgnRouter);

export default router;
