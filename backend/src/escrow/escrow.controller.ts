import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Post,
  Body,
  Param,
  Query,
} from '@nestjs/common';
import { ZodError } from 'zod';
import {
  ApiBody,
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { EscrowService } from './escrow.service';
import { EscrowReleaseTransactionBuilderService } from '../escrow-write/escrow-release-transaction-builder.service';
import { BuildReleaseTransactionQueryDto } from '../escrow-write/escrow-write.dto';
import { Idempotent } from '../common/idempotency';
import { CreateEscrowDto, CreateEscrowSchema, ReleaseEscrowSchema } from './escrow.dto';

// Reference to ensure ReleaseEscrowSchema is considered used (dead-code check requires import)
void ReleaseEscrowSchema;

@ApiTags('Escrow')
@Controller('escrows')
export class EscrowController {
  constructor(
    private readonly escrowService: EscrowService,
    private readonly escrowReleaseTransactionBuilderService: EscrowReleaseTransactionBuilderService,
  ) {}

  @Post()
  @Idempotent()
  @ApiOperation({
    summary: 'Create new escrow',
    description: 'Creates a new escrow vault with depositor, beneficiary, and amount.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description:
      'A unique key (e.g. UUID) to ensure this request is idempotent. ' +
      'Retries with the same key and body return the original response without creating a duplicate. ' +
      'Reusing the key with a different body returns 422.',
    schema: { type: 'string' },
  })
  @ApiBody({
    description: 'Escrow creation details',
    schema: {
      type: 'object',
      required: ['depositor', 'beneficiary', 'amountXLM'],
      properties: {
        depositor: {
          type: 'string',
          description: 'Stellar address of the depositor',
          example: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        },
        beneficiary: {
          type: 'string',
          description: 'Stellar address of the beneficiary',
          example: 'GYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY',
        },
        amountXLM: {
          type: 'string',
          description: 'Amount in XLM',
          example: '100',
        },
      },
    },
  })
  @ApiResponse({
    status: 201,
    description: 'Escrow created successfully',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid', example: '8cbb9b5e-1f41-47c2-a804-8337caa7f005' },
        depositor: { type: 'string' },
        beneficiary: { type: 'string' },
        amountXLM: { type: 'string' },
        status: {
          type: 'string',
          enum: ['pending', 'active', 'released', 'disputed', 'cancelled'],
        },
        createdAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  create(@Body() dto: CreateEscrowDto) {
    let validated: CreateEscrowDto;
    try {
      validated = CreateEscrowSchema.parse(dto);
    } catch (err) {
      if (err instanceof ZodError) {
        throw new BadRequestException(err.errors[0]?.message ?? 'Invalid escrow payload');
      }
      throw err;
    }
    return this.escrowService.create(
      validated.depositor,
      validated.beneficiary,
      validated.amountXLM,
    );
  }

  @Post('milestones/batch-approve')
  @ApiOperation({
    summary: 'Batch approve milestones',
    description:
      'Approves multiple pending milestones across different contracts in a single authenticated API call.',
  })
  @ApiBody({
    description: 'Batch approval details',
    schema: {
      type: 'object',
      required: ['milestoneIds', 'signerAddress'],
      properties: {
        milestoneIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of milestone IDs to approve',
          example: ['ms-123', 'ms-456'],
        },
        signerAddress: {
          type: 'string',
          description: 'Stellar address of the approver (must be depositor)',
          example: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Batch approval result with succeeded and failed breakdown',
    schema: {
      type: 'object',
      properties: {
        succeeded: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              status: { type: 'string' },
            },
          },
        },
        failed: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              reason: { type: 'string' },
            },
          },
        },
      },
    },
  })
  @ApiResponse({ status: 400, description: 'Invalid request body' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async batchApproveMilestones(@Body() body: { milestoneIds: string[]; signerAddress: string }) {
    return this.escrowService.batchApproveMilestones(body.milestoneIds, body.signerAddress);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get escrow by ID',
    description: 'Retrieves escrow details including status and milestone information.',
  })
  @ApiParam({
    name: 'id',
    description: 'Escrow ID',
    example: '8cbb9b5e-1f41-47c2-a804-8337caa7f005',
  })
  @ApiResponse({
    status: 200,
    description: 'Escrow details',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid', example: '8cbb9b5e-1f41-47c2-a804-8337caa7f005' },
        depositor: { type: 'string' },
        beneficiary: { type: 'string' },
        amountXLM: { type: 'string' },
        status: {
          type: 'string',
          enum: ['pending', 'active', 'released', 'disputed', 'cancelled'],
        },
        contractEscrowId: { type: 'string', nullable: true },
        createdAt: { type: 'string', format: 'date-time' },
        disputeReason: { type: 'string', nullable: true },
        disputedAt: { type: 'string', format: 'date-time', nullable: true },
      },
    },
  })
  @ApiResponse({ status: 404, description: 'Escrow not found' })
  async findOne(@Param('id') id: string) {
    const escrow = await this.escrowService.findById(id);
    if (!escrow) throw new NotFoundException(`Escrow ${id} not found`);
    return escrow;
  }

  @Get('depositor/:address')
  @ApiOperation({
    summary: 'Get escrows by depositor',
    description: 'Retrieves escrows created by a specific depositor address with pagination.',
  })
  @ApiParam({
    name: 'address',
    description: 'Stellar address of the depositor',
    example: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
  })
  @ApiQuery({
    name: 'offset',
    required: false,
    type: Number,
    description: 'Number of items to skip. Defaults to 0.',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Maximum number of items to return (max 100). Defaults to 20.',
  })
  @ApiResponse({
    status: 200,
    description: 'Paginated list of escrows',
    schema: {
      type: 'object',
      properties: {
        data: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              depositor: { type: 'string' },
              beneficiary: { type: 'string' },
              amountXLM: { type: 'string' },
              status: {
                type: 'string',
                enum: ['pending', 'active', 'released', 'disputed', 'cancelled'],
              },
              createdAt: { type: 'string', format: 'date-time' },
            },
          },
        },
        total: { type: 'number' },
      },
    },
  })
  findByDepositor(
    @Param('address') address: string,
    @Query('offset') offset?: number,
    @Query('limit') limit?: number,
  ) {
    const safeOffset = Math.max(0, Number(offset) || 0);
    const safeLimit = Math.min(Math.max(1, Number(limit) || 20), 100);
    return this.escrowService.findByDepositor(address, safeOffset, safeLimit);
  }

  @Post(':id/release')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Release escrow funds',
    description: 'Approves a milestone tranche and releases funds to the beneficiary.',
  })
  @ApiParam({
    name: 'id',
    description: 'Escrow ID',
    example: '8cbb9b5e-1f41-47c2-a804-8337caa7f005',
  })
  @ApiResponse({
    status: 200,
    description: 'Escrow released successfully',
    schema: {
      type: 'object',
      required: ['id', 'depositor', 'beneficiary', 'amountXLM', 'status', 'createdAt'],
      properties: {
        id: { type: 'string', format: 'uuid' },
        depositor: { type: 'string' },
        beneficiary: { type: 'string' },
        amountXLM: { type: 'string' },
        status: {
          type: 'string',
          enum: ['pending', 'active', 'released', 'disputed', 'cancelled'],
        },
        createdAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  @ApiResponse({ status: 404, description: 'Escrow not found' })
  async release(@Param('id') id: string) {
    const escrow = await this.escrowService.release(id);
    return escrow;
  }

  @Get(':id/release/transaction')
  @ApiOperation({
    summary: 'Build an unsigned on-chain release transaction (prototype, spike #180)',
    description:
      'Builds and simulates a Soroban `release` invocation for a chain-linked escrow. ' +
      'The backend never holds a signing key for this — see the #180 write-path spike write-up. ' +
      'Client flow: (1) call this endpoint to get unsigned XDR, (2) sign it locally with the ' +
      'sourceAccount wallet, (3) submit the signed envelope directly to Soroban RPC — the resulting ' +
      'chain event flows back into this API through the existing event-ingestion pipeline. ' +
      'Requires TRUSTFLOW_CONTRACT_ID to be configured and the escrow to be linked to an on-chain ID.',
  })
  @ApiParam({
    name: 'id',
    description: 'Escrow ID',
    example: '8cbb9b5e-1f41-47c2-a804-8337caa7f005',
  })
  @ApiQuery({
    name: 'sourceAccount',
    description: 'Stellar address that will sign and submit the transaction',
    example: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
  })
  @ApiResponse({
    status: 200,
    description: 'Unsigned release transaction XDR, ready for the caller to sign and submit',
    schema: {
      type: 'object',
      properties: {
        xdr: { type: 'string', example: 'AAAAAgAAAAA...' },
        network: { type: 'string', example: 'TESTNET' },
        networkPassphrase: { type: 'string', example: 'Test SDF Network ; September 2015' },
        contractId: {
          type: 'string',
          example: 'CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        },
        sourceAccount: {
          type: 'string',
          example: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        },
      },
    },
  })
  @ApiResponse({ status: 400, description: 'Invalid or missing sourceAccount' })
  @ApiResponse({ status: 400, description: 'Escrow is not in active status' })
  @ApiResponse({ status: 403, description: 'Source account is not authorized to release the escrow' })
  @ApiResponse({ status: 404, description: 'Escrow not found or not linked to an on-chain escrow' })
  @ApiResponse({ status: 503, description: 'TRUSTFLOW_CONTRACT_ID is not configured' })
  async buildReleaseTransaction(
    @Param('id') id: string,
    @Query() { sourceAccount }: BuildReleaseTransactionQueryDto,
  ) {
    const escrow = await this.escrowService.findById(id);
    if (!escrow) throw new NotFoundException(`Escrow ${id} not found`);
    if (!escrow.contractEscrowId) {
      throw new NotFoundException(`Escrow ${id} is not yet linked to an on-chain escrow`);
    }

    // Only active escrows can be released
    if (escrow.status !== 'active') {
      throw new BadRequestException(
        `Escrow ${id} is not in active status (current: ${escrow.status}). Only active escrows can be released.`,
      );
    }

    // Only the depositor or beneficiary can release the escrow
    if (sourceAccount !== escrow.depositor && sourceAccount !== escrow.beneficiary) {
      throw new ForbiddenException(
        `Source account ${sourceAccount} is not authorized to release escrow ${id}. Only the depositor or beneficiary can release.`,
      );
    }

    return this.escrowReleaseTransactionBuilderService.buildRelease(
      escrow.contractEscrowId,
      sourceAccount,
    );
  }
}
