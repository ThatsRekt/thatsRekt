import {Entity as Entity_, Column as Column_, PrimaryColumn as PrimaryColumn_, ManyToOne as ManyToOne_, Index as Index_, Relation as Relation_, StringColumn as StringColumn_, IntColumn as IntColumn_, DateTimeColumn as DateTimeColumn_} from "@subsquid/typeorm-store"
import {Post} from "./post.model"
import {EditKind} from "./_editKind"

@Entity_()
export class Edit {
    constructor(props?: Partial<Edit>) {
        Object.assign(this, props)
    }

    /**
     * txHash-logIndex
     */
    @PrimaryColumn_()
    id!: string

    @Index_()
    @ManyToOne_(() => Post, {nullable: true})
    post!: Relation_<Post>

    @Column_("varchar", {length: 12, nullable: false})
    kind!: EditKind

    /**
     * populated when kind = AmendNote
     */
    @StringColumn_({nullable: true})
    newNote!: string | undefined | null

    /**
     * populated when kind = AddAttackers — list of newly-added attacker addresses
     */
    @StringColumn_({array: true, nullable: true})
    addedAttackers!: (string)[] | undefined | null

    /**
     * populated when kind = AddVictims — list of newly-added victim addresses
     */
    @StringColumn_({array: true, nullable: true})
    addedVictims!: (string)[] | undefined | null

    @IntColumn_({nullable: false})
    blockNumber!: number

    @DateTimeColumn_({nullable: false})
    timestamp!: Date

    @StringColumn_({nullable: false})
    txHash!: string
}
