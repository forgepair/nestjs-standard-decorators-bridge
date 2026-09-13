import { Injectable } from '@nestjs/common';

@Injectable()
export class Logger {
  log(msg: string) { console.log(msg); }
}
