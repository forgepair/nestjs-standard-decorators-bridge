import { Injectable } from '@nestjs/common';

@Injectable()
export class UserService {
  find(id: string) { return { id }; }
}
