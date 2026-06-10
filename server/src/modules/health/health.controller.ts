import { Controller, Get } from "@nestjs/common";
import { Public } from "../../common/auth.decorators.js";

@Controller("health")
export class HealthController {
  @Public()
  @Get()
  getHealth() {
    return {
      status: "ok",
      service: "agenthub-api",
      timestamp: new Date().toISOString()
    };
  }
}
