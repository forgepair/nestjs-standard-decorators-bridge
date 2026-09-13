import { Injectable } from '@nestjs/common';
import { Repo } from './repo.interface';

@Injectable()
export class RepoConsumer {
  constructor(private readonly repo: Repo) {}
}
