import { Controller } from '@nestjs/common';
import { UserService } from './user.service';
import { Logger } from './logger';

@Controller('users')
export class UserController {
  constructor(
    private readonly userService: UserService,
    private readonly logger: Logger,
  ) {}
}
