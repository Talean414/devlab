import { TestBed } from '@angular/core/testing';
import { Queue } from './queue';

describe('Queue', () => {
  let service: Queue;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(Queue);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
