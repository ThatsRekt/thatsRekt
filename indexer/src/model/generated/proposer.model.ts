import {Entity as Entity_, Column as Column_, PrimaryColumn as PrimaryColumn_, IntColumn as IntColumn_, BigIntColumn as BigIntColumn_, DateTimeColumn as DateTimeColumn_} from "@subsquid/typeorm-store"

@Entity_()
export class Proposer {
    constructor(props?: Partial<Proposer>) {
        Object.assign(this, props)
    }

    /**
     * the address (lowercased)
     */
    @PrimaryColumn_()
    id!: string

    /**
     * lifetime count of posts authored on this chain
     */
    @IntColumn_({nullable: false})
    postCount!: number

    /**
     * Σ Post.confirmations across all this address's posts on this chain
     */
    @BigIntColumn_({nullable: false})
    totalConfirmations!: bigint

    /**
     * Σ Post.disconfirmations across all this address's posts on this chain
     */
    @BigIntColumn_({nullable: false})
    totalDisconfirmations!: bigint

    /**
     * block.timestamp of the first PostCreated authored by this address (null until first post)
     */
    @DateTimeColumn_({nullable: true})
    firstPostedAt!: Date | undefined | null

    @IntColumn_({nullable: true})
    firstPostedAtBlock!: number | undefined | null

    /**
     * bumped on every counter change
     */
    @DateTimeColumn_({nullable: false})
    lastUpdatedAt!: Date

    @IntColumn_({nullable: false})
    lastUpdatedAtBlock!: number
}
